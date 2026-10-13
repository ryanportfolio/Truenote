import { createHash, randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { clientIpFrom } from "../lib/auth/rate-limit.js";
import { isAbortError, getDeadlineConfig } from "../lib/deadlines.js";
import {
  complianceAskLimit,
  complianceReadLimit
} from "../lib/security/route-rate-limit.js";
import { answerComplianceQuestion } from "../lib/compliance/ask.js";
import {
  ComplianceIntegrityError,
  isComplianceSlug,
  readComplianceDocumentBody,
  readComplianceDocumentPdf,
  readComplianceManifest
} from "../lib/compliance/documents.js";
import { ComplianceProviderError } from "../lib/compliance/providers.js";
import {
  complianceManifestHash,
  getComplianceSearchIndex
} from "../lib/compliance/search-index.js";
import { recordAppError } from "../lib/observability/error-log.js";
import {
  recordSecurityEvent,
  recordSecurityEventBestEffort
} from "../lib/security/audit.js";
import { ProviderInputFirewallError } from "../lib/security/provider-input-firewall.js";
import {
  authedUser,
  requireAuth,
  requireComplianceReader,
  requireFreshPassword
} from "../middleware/current-user.js";

/**
 * Detailed compliance documents for super users (lib/compliance/documents.ts)
 * and questions about them (lib/compliance/ask.ts). The mutation audit
 * middleware does not cover /api/compliance; every document read and every
 * question records its own security event.
 */
export const complianceRouter = Router();

complianceRouter.use(requireAuth, requireFreshPassword, requireComplianceReader);

complianceRouter.get("/documents", complianceReadLimit, async (_req, res, next) => {
  try {
    const manifest = await readComplianceManifest();
    res.json({
      documents: manifest.documents.map(({ slug, title, version, date, sha256, size, pdf }) => ({
        slug,
        title,
        version,
        date,
        sha256,
        size,
        pdfSize: pdf ? pdf.size : null
      }))
    });
  } catch (error) {
    next(error);
  }
});

complianceRouter.get("/documents/:slug", complianceReadLimit, async (req, res, next) => {
  try {
    const user = authedUser(req);
    const requested = req.params.slug;
    if (!isComplianceSlug(requested)) {
      res.status(400).json({ error: "Invalid document id" });
      return;
    }
    const manifest = await readComplianceManifest();
    const entry = manifest.documents.find((candidate) => candidate.slug === requested);
    if (!entry) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    let markdown: string;
    try {
      markdown = await readComplianceDocumentBody(entry);
    } catch (error) {
      if (!(error instanceof ComplianceIntegrityError)) throw error;
      recordSecurityEventBestEffort({
        action: "compliance.document_read",
        outcome: "failure",
        actor: user,
        resourceType: "compliance_document",
        resourceId: entry.slug,
        sourceIp: clientIpFrom(req),
        details: { slug: entry.slug, sha256: entry.sha256, reason: "hash_mismatch" }
      });
      res.status(500).json({ error: "This document failed its integrity check" });
      return;
    }
    // Fail closed: the document goes out only after its read is on record.
    await recordSecurityEvent({
      action: "compliance.document_read",
      outcome: "success",
      actor: user,
      resourceType: "compliance_document",
      resourceId: entry.slug,
      sourceIp: clientIpFrom(req),
      details: { slug: entry.slug, sha256: entry.sha256, version: entry.version }
    });
    res.json({
      slug: entry.slug,
      title: entry.title,
      version: entry.version,
      date: entry.date,
      sha256: entry.sha256,
      pdfSize: entry.pdf ? entry.pdf.size : null,
      markdown
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Download name: the title and version, reduced to characters every OS accepts.
 * Most titles already start with "Truenote"; the prefix is added only when missing.
 */
function pdfFileName(title: string, version: string): string {
  const named = /^truenote\b/i.test(title) ? title : `Truenote ${title}`;
  const base = `${named} v${version}`
    .replace(/[^A-Za-z0-9 .()+-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150);
  return `${base}.pdf`;
}

complianceRouter.get("/documents/:slug/pdf", complianceReadLimit, async (req, res, next) => {
  try {
    const user = authedUser(req);
    const requested = req.params.slug;
    if (!isComplianceSlug(requested)) {
      res.status(400).json({ error: "Invalid document id" });
      return;
    }
    const manifest = await readComplianceManifest();
    const entry = manifest.documents.find((candidate) => candidate.slug === requested);
    const pdf = entry?.pdf;
    if (!entry || !pdf) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    let body: Buffer;
    try {
      body = await readComplianceDocumentPdf({ ...entry, pdf });
    } catch (error) {
      if (!(error instanceof ComplianceIntegrityError)) throw error;
      recordSecurityEventBestEffort({
        action: "compliance.document_read",
        outcome: "failure",
        actor: user,
        resourceType: "compliance_document",
        resourceId: entry.slug,
        sourceIp: clientIpFrom(req),
        details: { slug: entry.slug, format: "pdf", sha256: pdf.sha256, reason: "hash_mismatch" }
      });
      res.status(500).json({ error: "This document failed its integrity check" });
      return;
    }
    // Fail closed, as for the Markdown: the file goes out only after its read is on record.
    await recordSecurityEvent({
      action: "compliance.document_read",
      outcome: "success",
      actor: user,
      resourceType: "compliance_document",
      resourceId: entry.slug,
      sourceIp: clientIpFrom(req),
      details: { slug: entry.slug, format: "pdf", sha256: pdf.sha256, version: entry.version }
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${pdfFileName(entry.title, entry.version)}"`
    );
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(body);
  } catch (error) {
    next(error);
  }
});

const AskBodySchema = z
  .object({ question: z.string().trim().min(1).max(1_000) })
  .strict();

const ASK_UNAVAILABLE = "The compliance assistant could not answer right now. Try again in a minute.";

/**
 * Ask a question about the compliance documents. The answer cites document
 * sections or is the exact refusal. Owner decision, 2026-10-13: the security
 * event records a SHA-256 and the length of the question, never its text,
 * because questions can quote weaknesses. The answer goes out only after the
 * event is on record.
 */
complianceRouter.post("/ask", complianceAskLimit, async (req, res, next) => {
  const user = authedUser(req);
  const parsed = AskBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Ask a question of 1 to 1000 characters." });
    return;
  }
  const question = parsed.data.question;
  const correlationId = randomUUID();
  const eventBase = {
    action: "compliance.question",
    actor: user,
    resourceType: "compliance_question",
    resourceId: correlationId,
    sourceIp: clientIpFrom(req)
  } as const;
  const questionDetails = {
    questionSha256: createHash("sha256").update(question, "utf8").digest("hex"),
    questionLength: question.length
  };

  const controller = new AbortController();
  const abortOnClose = (): void => {
    if (!res.writableEnded) controller.abort(new Error("client closed the request"));
  };
  res.on("close", abortOnClose);
  // One budget for the whole question, index build included.
  const deadline = setTimeout(
    () => controller.abort(new Error("compliance ask deadline exceeded")),
    getDeadlineConfig().askDeadlineMs
  );

  try {
    const manifest = await readComplianceManifest();
    const index = await getComplianceSearchIndex(manifest, {}, { signal: controller.signal });
    const result = await answerComplianceQuestion(question, index, {
      signal: controller.signal,
      diagnostics: { correlationId, userId: user.id }
    });

    // Answers never cite a superseded version: if an upload replaced the
    // manifest while this answer was prepared or recorded, ask again instead.
    const manifestChanged = async (): Promise<boolean> =>
      complianceManifestHash(await readComplianceManifest()) !== index.manifestHash;
    const askAgain = (stage: string): void => {
      recordSecurityEventBestEffort({
        ...eventBase,
        outcome: "failure",
        details: { ...questionDetails, reason: "manifest_changed", stage, manifestHash: index.manifestHash }
      });
      res.status(409).json({
        error: "The compliance documents were updated while this answer was prepared. Ask again."
      });
    };
    if (await manifestChanged()) {
      askAgain("before_record");
      return;
    }
    if (controller.signal.aborted) throw controller.signal.reason;

    const cited = Array.from(
      new Map(
        result.sources.map((source) => [
          source.slug,
          { slug: source.slug, sha256: source.sha256, version: source.version }
        ])
      ).values()
    );
    await recordSecurityEvent({
      ...eventBase,
      outcome: "success",
      details: {
        ...questionDetails,
        refused: result.refused,
        cited,
        passages: result.sources.length,
        manifestHash: index.manifestHash,
        generationPath: result.generationPath
      }
    });
    // Last check, after the record and before delivery. The recorded event
    // stays; the follow-up failure event says the answer was not delivered.
    if (await manifestChanged()) {
      askAgain("after_record");
      return;
    }
    if (res.destroyed) return;
    res.json({ answer: result.answer, refused: result.refused, sources: result.sources });
  } catch (error) {
    if (res.writableEnded || res.headersSent) return;
    if (error instanceof ComplianceIntegrityError) {
      recordSecurityEventBestEffort({
        ...eventBase,
        outcome: "failure",
        details: { ...questionDetails, reason: "hash_mismatch", slug: error.slug }
      });
      res.status(500).json({ error: "A compliance document failed its integrity check" });
      return;
    }
    if (
      error instanceof ComplianceProviderError ||
      error instanceof ProviderInputFirewallError ||
      isAbortError(error) ||
      controller.signal.aborted
    ) {
      // Rerank or embedding down, or the deadline passed: no answer at all,
      // never one from unranked passages.
      void recordAppError({
        severity: "warning",
        source: "compliance",
        operation: "compliance-ask",
        error,
        correlationId,
        userId: user.id,
        context: {
          stage: error instanceof ComplianceProviderError ? error.stage : null,
          status: error instanceof ComplianceProviderError ? error.status : null,
          aborted: controller.signal.aborted
        }
      });
      recordSecurityEventBestEffort({
        ...eventBase,
        outcome: "failure",
        details: { ...questionDetails, reason: "unavailable" }
      });
      if (!res.destroyed) res.status(503).json({ error: ASK_UNAVAILABLE });
      return;
    }
    next(error);
  } finally {
    clearTimeout(deadline);
    res.off("close", abortOnClose);
  }
});

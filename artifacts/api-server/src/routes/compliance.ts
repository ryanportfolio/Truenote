import { Router } from "express";
import { clientIpFrom } from "../lib/auth/rate-limit.js";
import { complianceReadLimit } from "../lib/security/route-rate-limit.js";
import {
  ComplianceIntegrityError,
  isComplianceSlug,
  readComplianceDocumentBody,
  readComplianceManifest
} from "../lib/compliance/documents.js";
import {
  recordSecurityEvent,
  recordSecurityEventBestEffort
} from "../lib/security/audit.js";
import {
  authedUser,
  requireAuth,
  requireFreshPassword,
  requireSuperUser
} from "../middleware/current-user.js";

/**
 * Detailed compliance documents for super users (lib/compliance/documents.ts).
 * Every route is GET, so the mutation audit middleware does not see these
 * reads; the document route records its own security event.
 */
export const complianceRouter = Router();

complianceRouter.use(requireAuth, requireFreshPassword, requireSuperUser);

complianceRouter.get("/documents", complianceReadLimit, async (_req, res, next) => {
  try {
    const manifest = await readComplianceManifest();
    res.json({
      documents: manifest.documents.map(({ slug, title, version, date, sha256, size }) => ({
        slug,
        title,
        version,
        date,
        sha256,
        size
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
      markdown
    });
  } catch (error) {
    next(error);
  }
});

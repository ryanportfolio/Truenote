/**
 * The compliance assistant's search index, held in the web process.
 *
 * Owner decision, 2026-10-13: no database tables. The index is built from
 * object storage: the manifest, then every listed document (hash-checked by
 * readComplianceDocumentBody), split into passages and embedded. Customer
 * knowledge lives in Postgres; compliance text never does, so no customer
 * query can reach it and no compliance query can reach customer content.
 *
 * The index is keyed by a hash of the manifest's document list. Every
 * question reads the manifest first; when the hash differs from the cached
 * index, the index is rebuilt before retrieval, so an answer can only cite
 * the versions the manifest lists at that moment.
 *
 * Passage vectors are cached in object storage under compliance/index/, keyed
 * by the manifest hash, chunker version and embedding route, so a restart or
 * deploy reads the cache instead of sending every document to the embedding
 * provider again. The cache holds vectors and passage hashes only; passage
 * text always comes from the hash-checked documents. A cache entry that does
 * not match the passages exactly is ignored and rebuilt.
 */
import { createHash } from "node:crypto";
import { recordAppError } from "../observability/error-log.js";
import { getObjectStorage, type ObjectStorage } from "../storage/object-storage.js";
import { buildBm25Index, type Bm25Index } from "./bm25.js";
import {
  COMPLIANCE_CHUNKER_VERSION,
  chunkComplianceDocument,
  type CompliancePassage
} from "./chunking.js";
import {
  COMPLIANCE_KEY_PREFIX,
  readComplianceDocumentBody,
  readComplianceManifest,
  type ComplianceManifest
} from "./documents.js";
import {
  COMPLIANCE_EMBEDDING_ROUTE,
  embedComplianceTexts,
  type ComplianceProviderDeps
} from "./providers.js";

export interface ComplianceSearchIndex {
  manifestHash: string;
  passages: CompliancePassage[];
  vectors: Float32Array[];
  bm25: Bm25Index;
}

/** Stable hash of what the manifest lists: slug, content hash and version of each document. */
export function complianceManifestHash(manifest: ComplianceManifest): string {
  const listed = manifest.documents
    .map(({ slug, sha256, version, title }) => ({ slug, sha256, version, title }))
    .sort((left, right) => (left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(listed)).digest("hex");
}

/** Text the retrievers score: title and section give short passages their context. */
export function passageSearchText(passage: CompliancePassage): string {
  return [passage.title, passage.section, passage.content].filter(Boolean).join("\n");
}

function contentHash(passage: CompliancePassage): string {
  return createHash("sha256").update(passageSearchText(passage)).digest("hex");
}

export function complianceVectorCacheKey(manifestHash: string): string {
  const key = createHash("sha256")
    .update(
      JSON.stringify({
        manifestHash,
        chunker: COMPLIANCE_CHUNKER_VERSION,
        model: COMPLIANCE_EMBEDDING_ROUTE.model,
        provider: COMPLIANCE_EMBEDDING_ROUTE.provider
      })
    )
    .digest("hex");
  return `${COMPLIANCE_KEY_PREFIX}index/${key}.json`;
}

interface VectorCacheFile {
  schemaVersion: 1;
  dimensions: number;
  passages: Array<{ id: string; hash: string }>;
  /** Little-endian float32, passage after passage, base64. */
  vectors: string;
}

function encodeCache(passages: CompliancePassage[], vectors: number[][]): Buffer {
  const dimensions = vectors[0]?.length ?? 0;
  const floats = new Float32Array(passages.length * dimensions);
  vectors.forEach((vector, row) => floats.set(vector, row * dimensions));
  const file: VectorCacheFile = {
    schemaVersion: 1,
    dimensions,
    passages: passages.map((passage) => ({ id: passage.id, hash: contentHash(passage) })),
    vectors: Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength).toString("base64")
  };
  return Buffer.from(JSON.stringify(file), "utf8");
}

function decodeCache(body: Buffer, passages: CompliancePassage[]): Float32Array[] | null {
  let file: VectorCacheFile;
  try {
    file = JSON.parse(body.toString("utf8")) as VectorCacheFile;
  } catch {
    return null;
  }
  if (
    file?.schemaVersion !== 1 ||
    !Number.isInteger(file.dimensions) ||
    file.dimensions <= 0 ||
    !Array.isArray(file.passages) ||
    file.passages.length !== passages.length ||
    typeof file.vectors !== "string"
  ) {
    return null;
  }
  for (const [index, passage] of passages.entries()) {
    const cached = file.passages[index];
    if (!cached || cached.id !== passage.id || cached.hash !== contentHash(passage)) return null;
  }
  const bytes = Buffer.from(file.vectors, "base64");
  if (bytes.byteLength !== passages.length * file.dimensions * 4) return null;
  const vectors: Float32Array[] = [];
  for (let row = 0; row < passages.length; row += 1) {
    const vector = new Float32Array(file.dimensions);
    for (let column = 0; column < file.dimensions; column += 1) {
      vector[column] = bytes.readFloatLE((row * file.dimensions + column) * 4);
    }
    vectors.push(vector);
  }
  return vectors;
}

export interface ComplianceIndexDeps {
  storage?: ObjectStorage;
  providers?: ComplianceProviderDeps;
  /** Overrides embedding for tests. */
  embed?: (texts: string[]) => Promise<number[][]>;
  /** Overrides the shared build timeout for tests. */
  buildTimeoutMs?: number;
}

/**
 * Upper bound on one shared build. A build serves every question waiting on
 * the same manifest, so it is not tied to any one request; each request still
 * stops waiting at its own deadline (getComplianceSearchIndex).
 */
const BUILD_TIMEOUT_MS = 120_000;

async function buildIndex(
  manifest: ComplianceManifest,
  manifestHash: string,
  deps: ComplianceIndexDeps,
  signal: AbortSignal
): Promise<ComplianceSearchIndex> {
  const storage = deps.storage ?? getObjectStorage();
  const passages: CompliancePassage[] = [];
  for (const entry of manifest.documents) {
    signal.throwIfAborted();
    const markdown = await readComplianceDocumentBody(entry, storage);
    passages.push(...chunkComplianceDocument(entry, markdown));
  }

  const cacheKey = complianceVectorCacheKey(manifestHash);
  let vectors: Float32Array[] | null = null;
  if (passages.length > 0 && (await storage.exists(cacheKey))) {
    vectors = decodeCache(await storage.get(cacheKey), passages);
  }
  if (!vectors) {
    const texts = passages.map(passageSearchText);
    const embedded =
      passages.length === 0
        ? []
        : deps.embed
          ? await deps.embed(texts)
          : await embedComplianceTexts(texts, "document", { signal }, deps.providers);
    vectors = embedded.map((vector) => Float32Array.from(vector));
    if (passages.length > 0) {
      await storage.put(cacheKey, encodeCache(passages, embedded), {
        contentType: "application/json"
      });
    }
  }

  return {
    manifestHash,
    passages,
    vectors,
    bm25: buildBm25Index(passages.map(passageSearchText))
  };
}

let current: ComplianceSearchIndex | null = null;
let building: { manifestHash: string; promise: Promise<ComplianceSearchIndex> } | null = null;

/**
 * The index for this manifest: the cached one when the hash matches, else a
 * fresh build. Concurrent callers for the same manifest share one build. A
 * failed build is not cached, so the next question tries again. A caller's
 * signal ends its wait, not the shared build.
 */
export async function getComplianceSearchIndex(
  manifest: ComplianceManifest,
  deps: ComplianceIndexDeps = {},
  options: { signal?: AbortSignal } = {}
): Promise<ComplianceSearchIndex> {
  const manifestHash = complianceManifestHash(manifest);
  if (current?.manifestHash === manifestHash) return current;
  if (building?.manifestHash === manifestHash) return waitFor(building.promise, options.signal);
  // The timeout covers the whole build, storage reads included: a stalled
  // read fails the build, which clears `building` so the next question retries.
  const signal = AbortSignal.timeout(deps.buildTimeoutMs ?? BUILD_TIMEOUT_MS);
  const promise = waitFor(buildIndex(manifest, manifestHash, deps, signal), signal).then(
    (index) => {
      if (building?.promise === promise) building = null;
      current = index;
      return index;
    },
    (error: unknown) => {
      if (building?.promise === promise) building = null;
      throw error;
    }
  );
  building = { manifestHash, promise };
  // A build whose waiters all gave up still settles; its failure is not unhandled.
  promise.catch(() => undefined);
  return waitFor(promise, options.signal);
}

/** The promise, or the signal's reason as soon as it aborts. The work itself carries on. */
export function waitFor<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

/**
 * Build the index in the background so the first question after a deploy or
 * an upload does not wait for every passage to be embedded. Called when the
 * web service starts and when the Compliance page lists the documents; with
 * the vector cache in place a warm start is a storage read. Failures are
 * logged and the next question builds again.
 */
export function warmComplianceIndex(
  manifest?: ComplianceManifest,
  deps: ComplianceIndexDeps = {}
): void {
  void (manifest ? Promise.resolve(manifest) : readComplianceManifest(deps.storage))
    .then((listed) => (listed.documents.length > 0 ? getComplianceSearchIndex(listed, deps) : null))
    .catch((error: unknown) => {
      void recordAppError({
        severity: "warning",
        source: "compliance",
        operation: "compliance-index-warm",
        error
      });
    });
}

export function __resetComplianceSearchIndexForTests(): void {
  current = null;
  building = null;
}

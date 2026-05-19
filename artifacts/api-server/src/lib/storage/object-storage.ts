/**
 * Object storage abstraction.
 *
 * Production: Replit Object Storage (via @replit/object-storage). The Replit
 * SDK reads auth automatically from the Replit runtime; the bucket id comes
 * from REPLIT_OBJECT_STORAGE_BUCKET (or defaults to the workspace bucket).
 *
 * Tests: InMemoryObjectStorage — same interface, no I/O.
 *
 * Phase 2 may add a signed-URL method; for now Mistral OCR receives base64,
 * so we never need a public URL for parsing. Keeping the interface minimal.
 */

export interface PutOptions {
  contentType?: string;
}

export interface ObjectStorage {
  put(key: string, data: Buffer, options?: PutOptions): Promise<void>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
}

export class InMemoryObjectStorage implements ObjectStorage {
  private readonly bucket = new Map<string, Buffer>();

  async put(key: string, data: Buffer, _options?: PutOptions): Promise<void> {
    this.bucket.set(key, Buffer.from(data));
  }

  async get(key: string): Promise<Buffer> {
    const value = this.bucket.get(key);
    if (!value) throw new Error(`No object at key: ${key}`);
    return value;
  }

  async exists(key: string): Promise<boolean> {
    return this.bucket.has(key);
  }

  /** Test-only helper for inspection. */
  size(): number {
    return this.bucket.size;
  }
}

interface ReplitObjectStorageClient {
  uploadFromBytes(name: string, bytes: Buffer): Promise<{ ok: boolean; error?: unknown }>;
  downloadAsBytes(name: string): Promise<{ ok: boolean; value?: Buffer[]; error?: unknown }>;
  exists(name: string): Promise<{ ok: boolean; value?: boolean; error?: unknown }>;
}

interface ReplitObjectStorageModule {
  Client: new (config?: { bucketId?: string }) => ReplitObjectStorageClient;
}

/**
 * Lazy-loaded Replit Object Storage adapter.
 *
 * The Replit SDK is only available inside the Replit runtime. Importing it
 * statically would break tests and would break the chunker tests in this
 * sandbox. We dynamic-import on first use; if the SDK isn't installed,
 * a clear error is raised so the call site can decide how to handle it.
 */
export class ReplitObjectStorage implements ObjectStorage {
  private clientPromise: Promise<ReplitObjectStorageClient> | null = null;

  private async client(): Promise<ReplitObjectStorageClient> {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        try {
          // Dynamic import to avoid a hard dep at module-evaluation time.
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          const mod = (await import("@replit/object-storage")) as ReplitObjectStorageModule;
          const bucketId = process.env.REPLIT_OBJECT_STORAGE_BUCKET;
          return new mod.Client(bucketId ? { bucketId } : undefined);
        } catch (err) {
          throw new Error(
            `@replit/object-storage is not available. Install it on Replit. (${String(err)})`
          );
        }
      })();
    }
    return this.clientPromise;
  }

  async put(key: string, data: Buffer, _options?: PutOptions): Promise<void> {
    const c = await this.client();
    const result = await c.uploadFromBytes(key, data);
    if (!result.ok) {
      throw new Error(`Replit Object Storage put failed: ${String(result.error)}`);
    }
  }

  async get(key: string): Promise<Buffer> {
    const c = await this.client();
    const result = await c.downloadAsBytes(key);
    if (!result.ok || !result.value || result.value.length === 0) {
      throw new Error(`Replit Object Storage get failed: ${String(result.error)}`);
    }
    return Buffer.concat(result.value);
  }

  async exists(key: string): Promise<boolean> {
    const c = await this.client();
    const result = await c.exists(key);
    return Boolean(result.ok && result.value);
  }
}

let _storage: ObjectStorage | null = null;

/**
 * Default object storage instance. Returns InMemoryObjectStorage when
 * RAG_STORAGE_DRIVER=memory (set by tests and seed scripts). Otherwise
 * returns ReplitObjectStorage.
 */
export function getObjectStorage(): ObjectStorage {
  if (_storage) return _storage;
  if (process.env.RAG_STORAGE_DRIVER === "memory") {
    _storage = new InMemoryObjectStorage();
  } else {
    _storage = new ReplitObjectStorage();
  }
  return _storage;
}

/** Test-only: reset the cached instance so tests can isolate. */
export function __resetObjectStorageForTests(next?: ObjectStorage): void {
  _storage = next ?? null;
}

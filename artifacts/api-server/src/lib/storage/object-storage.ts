/**
 * Object storage abstraction.
 *
 * Railway: any S3-compatible bucket (RAG_STORAGE_DRIVER=s3). Configured by
 * S3_BUCKET, S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY
 * and optional S3_FORCE_PATH_STYLE=true.
 *
 * Replit (driver unset): Replit Object Storage via @replit/object-storage.
 * The Replit SDK reads auth automatically from the Replit runtime; the bucket
 * id comes from REPLIT_OBJECT_STORAGE_BUCKET (or defaults to the workspace
 * bucket). Kept until the Railway cutover is complete.
 *
 * Tests: InMemoryObjectStorage — same interface, no I/O.
 *
 * Phase 2 may add a signed-URL method; for now Mistral OCR receives base64,
 * so we never need a public URL for parsing. Keeping the interface minimal.
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";

export interface PutOptions {
  contentType?: string;
}

export interface ObjectStorage {
  put(key: string, data: Buffer, options?: PutOptions): Promise<void>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  /**
   * Remove an object from the bucket. Idempotent — deleting a key
   * that doesn't exist resolves without error so the document-delete
   * route can call this without first checking exists().
   */
  delete(key: string): Promise<void>;
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

  async delete(key: string): Promise<void> {
    this.bucket.delete(key);
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
  // The Replit SDK exposes delete() and surfaces a "not found" via
  // result.error rather than throwing — same shape as the other
  // operations. We map that to a no-op so the interface contract
  // ("idempotent") stays true regardless of bucket state.
  delete(name: string): Promise<{ ok: boolean; error?: unknown }>;
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

  async delete(key: string): Promise<void> {
    const c = await this.client();
    const result = await c.delete(key);
    if (!result.ok) {
      // The SDK's delete() returns ok:false for both "not found" and
      // "real failure". Inspect the error to distinguish: a 404-style
      // "ObjectNotFound" / "NoSuchKey" is the idempotent path we want
      // to swallow. Anything else bubbles up so a real bucket outage
      // doesn't silently leave orphaned blobs in storage.
      const errStr = String(result.error ?? "").toLowerCase();
      if (
        errStr.includes("not found") ||
        errStr.includes("nosuchkey") ||
        errStr.includes("objectnotfound")
      ) {
        return;
      }
      throw new Error(`Replit Object Storage delete failed: ${String(result.error)}`);
    }
  }
}

export interface S3StorageConfig {
  bucket: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

const S3_ENV_VARS = [
  "S3_BUCKET",
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY"
] as const;

/**
 * Read the S3 settings from env. Throws naming every missing variable (never
 * their values) so a misconfigured deploy fails on its first storage call
 * with an actionable message.
 */
export function s3ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): S3StorageConfig {
  const missing = S3_ENV_VARS.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `RAG_STORAGE_DRIVER=s3 requires ${missing.join(", ")} to be set.`
    );
  }
  return {
    bucket: env.S3_BUCKET!.trim(),
    endpoint: env.S3_ENDPOINT!.trim(),
    region: env.S3_REGION!.trim(),
    accessKeyId: env.S3_ACCESS_KEY_ID!.trim(),
    secretAccessKey: env.S3_SECRET_ACCESS_KEY!.trim(),
    forcePathStyle: env.S3_FORCE_PATH_STYLE?.trim().toLowerCase() === "true"
  };
}

function errorName(err: unknown): string | undefined {
  return err && typeof err === "object" ? (err as { name?: string }).name : undefined;
}

/**
 * HEAD responses carry no error body, so on AWS a missing object and a
 * missing bucket can both arrive as `NotFound`. Railway Buckets answered a
 * missing bucket with a different error (checked 2026-10-07), which
 * propagates. A misconfigured bucket still fails loudly on put/get/delete.
 */
function isMissingObjectOnHead(err: unknown): boolean {
  const name = errorName(err);
  return name === "NotFound" || name === "NoSuchKey";
}

/** S3-compatible adapter (Railway Buckets, AWS S3, R2, MinIO). */
export class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: S3StorageConfig) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey
      }
    });
  }

  async put(key: string, data: Buffer, options?: PutOptions): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
        ContentType: options?.contentType
      })
    );
  }

  async get(key: string): Promise<Buffer> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key })
    );
    if (!result.Body) throw new Error(`No object at key: ${key}`);
    return Buffer.from(await result.Body.transformToByteArray());
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key })
      );
      return true;
    } catch (err) {
      if (isMissingObjectOnHead(err)) return false;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    // S3 DeleteObject already succeeds for a missing key; a NoSuchKey from a
    // stricter S3-compatible provider is the same idempotent outcome. Any
    // other error, NoSuchBucket included, propagates so purge accounting
    // records the cleanup as pending instead of done.
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key })
      );
    } catch (err) {
      if (errorName(err) === "NoSuchKey") return;
      throw err;
    }
  }
}

let _storage: ObjectStorage | null = null;

/**
 * Default object storage instance, chosen by RAG_STORAGE_DRIVER:
 * `memory` (tests and seed scripts) → InMemoryObjectStorage;
 * `s3` → S3ObjectStorage; unset → ReplitObjectStorage.
 */
export function getObjectStorage(): ObjectStorage {
  if (_storage) return _storage;
  const driver = process.env.RAG_STORAGE_DRIVER?.trim().toLowerCase();
  if (driver === "memory") {
    _storage = new InMemoryObjectStorage();
  } else if (driver === "s3") {
    _storage = new S3ObjectStorage(s3ConfigFromEnv());
  } else {
    _storage = new ReplitObjectStorage();
  }
  return _storage;
}

/** Test-only: reset the cached instance so tests can isolate. */
export function __resetObjectStorageForTests(next?: ObjectStorage): void {
  _storage = next ?? null;
}

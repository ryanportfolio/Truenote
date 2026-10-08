/**
 * Object storage abstraction.
 *
 * Default: any S3-compatible bucket (Railway Buckets in production).
 * Configured by S3_BUCKET, S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID,
 * S3_SECRET_ACCESS_KEY and optional S3_FORCE_PATH_STYLE=true.
 *
 * Tests and seed scripts: InMemoryObjectStorage (RAG_STORAGE_DRIVER=memory),
 * same interface, no I/O.
 *
 * Phase 2 may add a signed-URL method; for now LandingAI receives the file
 * bytes in a multipart upload, so we never need a public URL for parsing. Keeping the interface minimal.
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
      `S3 object storage requires ${missing.join(", ")} to be set (or RAG_STORAGE_DRIVER=memory for the in-memory store).`
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
 * `memory` (tests and seed scripts) -> InMemoryObjectStorage; any other
 * value, unset included, -> S3ObjectStorage configured from the S3_* env
 * vars. A missing S3_* var fails here, on the first storage call.
 */
export function getObjectStorage(): ObjectStorage {
  if (_storage) return _storage;
  const driver = process.env.RAG_STORAGE_DRIVER?.trim().toLowerCase();
  if (driver === "memory") {
    _storage = new InMemoryObjectStorage();
  } else {
    _storage = new S3ObjectStorage(s3ConfigFromEnv());
  }
  return _storage;
}

/** Test-only: reset the cached instance so tests can isolate. */
export function __resetObjectStorageForTests(next?: ObjectStorage): void {
  _storage = next ?? null;
}

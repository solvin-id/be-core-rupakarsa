import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import type {
  ByteRange,
  PutResult,
  StorageDriver,
  StoredObject,
  StoredObjectMeta,
  StoredRange,
} from "../adapters/types.js";
import { env } from "../env.js";
import { assertSafeKey, mimeFor } from "./local-driver.js";

/**
 * A ranged GET reports the requested slice in `Content-Length`, so using it as the object size
 * makes `Content-Range` claim the wrong length on every seek. The `/total` suffix of
 * `Content-Range` is authoritative; `Content-Length` is only the whole-object fallback a
 * non-ranged response needs.
 */
export function totalSizeFrom(
  contentRange: string | undefined,
  contentLength: number | undefined,
  fallback: number,
): number {
  const total = Number(contentRange?.split("/")[1]);
  if (Number.isFinite(total) && total > 0) return total;
  if (typeof contentLength === "number" && Number.isFinite(contentLength)) return contentLength;
  return fallback;
}

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl: string;
  forcePathStyle: boolean;
}

function configFromEnv(): S3Config {
  return {
    endpoint:
      env.R2_ACCOUNT_ID.length > 0 ? `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : "",
    region: "auto",
    bucket: env.R2_BUCKET,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    publicBaseUrl: env.R2_PUBLIC_BASE_URL,
    forcePathStyle: false,
  };
}

/** S3-compatible driver: Cloudflare R2, MinIO, alist and any other S3 endpoint. */
export class S3StorageDriver implements StorageDriver {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicBase: string;

  constructor(config: S3Config) {
    this.client = new S3Client({
      region: config.region.length > 0 ? config.region : "auto",
      endpoint: config.endpoint.length > 0 ? config.endpoint : undefined,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
    this.bucket = config.bucket;
    this.publicBase = config.publicBaseUrl.replace(/\/+$/, "");
  }

  async put(key: string, bytes: Buffer, mime: string): Promise<PutResult> {
    assertSafeKey(key);
    const result = await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentType: mime,
        CacheControl: "public, max-age=31536000, immutable",
      }),
    );
    return result.ETag ? { externalId: result.ETag.replace(/"/g, "") } : {};
  }

  url(key: string): string {
    assertSafeKey(key);
    return `${this.publicBase}/${key}`;
  }

  async read(key: string): Promise<StoredObject | null> {
    try {
      assertSafeKey(key);
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const bytes = result.Body ? Buffer.from(await result.Body.transformToByteArray()) : null;
      if (!bytes) return null;
      return { bytes, mime: result.ContentType ?? mimeFor(key) };
    } catch {
      return null;
    }
  }

  async stat(key: string): Promise<StoredObjectMeta | null> {
    try {
      assertSafeKey(key);
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (typeof result.ContentLength !== "number") return null;
      return { size: result.ContentLength, mime: result.ContentType ?? mimeFor(key) };
    } catch {
      return null;
    }
  }

  async readRange(key: string, range: ByteRange): Promise<StoredRange | null> {
    try {
      assertSafeKey(key);
      const result = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Range: `bytes=${range.start}-${range.end}`,
        }),
      );
      const bytes = result.Body ? Buffer.from(await result.Body.transformToByteArray()) : null;
      if (!bytes) return null;
      return {
        bytes,
        mime: result.ContentType ?? mimeFor(key),
        size: totalSizeFrom(result.ContentRange, result.ContentLength, bytes.byteLength),
      };
    } catch {
      return null;
    }
  }

  async remove(key: string): Promise<void> {
    assertSafeKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

export function createS3Storage(config: S3Config): S3StorageDriver {
  return new S3StorageDriver(config);
}

export function envS3Config(): S3Config {
  return configFromEnv();
}

export function envS3Available(): boolean {
  const config = configFromEnv();
  return config.bucket.length > 0 && config.accessKeyId.length > 0;
}

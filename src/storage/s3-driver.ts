import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import type { PutResult, StorageDriver, StoredObject } from "../adapters/types.js";
import { env } from "../env.js";
import { assertSafeKey, mimeFor } from "./local-driver.js";

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

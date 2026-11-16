import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { env } from "../env.js";
import type { StorageDriver, StoredObject } from "../adapters/types.js";
import { assertSafeKey } from "./local-driver.js";

export class R2StorageDriver implements StorageDriver {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicBase: string;

  constructor() {
    this.client = new S3Client({
      region: "auto",
      endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
    });
    this.bucket = env.R2_BUCKET;
    this.publicBase = env.R2_PUBLIC_BASE_URL.replace(/\/+$/, "");
  }

  async put(key: string, bytes: Buffer, mime: string): Promise<void> {
    assertSafeKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentType: mime,
        CacheControl: "public, max-age=31536000, immutable",
      }),
    );
  }

  url(key: string): string {
    assertSafeKey(key);
    return `${this.publicBase}/${key}`;
  }

  async read(_key: string): Promise<StoredObject | null> {
    // Public bucket URLs serve reads directly; the API does not proxy R2 objects.
    return null;
  }
}

export function createR2Storage(): R2StorageDriver {
  return new R2StorageDriver();
}

export { GetObjectCommand };

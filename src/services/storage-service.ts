import { createHmac, timingSafeEqual } from "node:crypto";

import { and, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";

import type { StorageDriver } from "../adapters/types.js";
import { db } from "../db/client.js";
import { mediaAssets, workspaceStorage } from "../db/schema.js";
import type { GenerationRow, MediaAssetRow } from "../db/schema.js";
import { decryptSecret } from "../crypto/encryption.js";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { GDriveStorageDriver, gdriveDownloadUrl } from "../storage/gdrive-driver.js";
import { LocalStorageDriver } from "../storage/local-driver.js";
import { createS3Storage, envS3Available, envS3Config } from "../storage/s3-driver.js";
import { getStorageSettings } from "./settings.js";
import { accessTokenFor } from "./workspace-drive-service.js";

export type StorageKind = "local" | "s3" | "gdrive";

export interface ResolvedStorage {
  driver: StorageDriver;
  kind: StorageKind;
  retentionDays: number;
}

export interface AssetMeta {
  uploadedBy?: string | null;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  checksum?: string | null;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { value: ResolvedStorage; expiresAt: number }>();

function cacheGet(key: string): ResolvedStorage | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key: string, value: ResolvedStorage): ResolvedStorage {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

export function clearStorageCache(): void {
  cache.clear();
}

async function globalStorage(): Promise<ResolvedStorage> {
  const cached = cacheGet("global");
  if (cached) return cached;

  const settings = await getStorageSettings(db);
  if (settings.driver === "s3") {
    const config = settings.s3;
    if (config.bucket.trim().length > 0) {
      return cacheSet("global", {
        driver: createS3Storage({
          endpoint: config.endpoint,
          region: config.region,
          bucket: config.bucket,
          accessKeyId: config.accessKeyId,
          secretAccessKey:
            config.secretAccessKeyEncrypted.length > 0
              ? decryptSecret(config.secretAccessKeyEncrypted)
              : "",
          publicBaseUrl: config.publicBaseUrl,
          forcePathStyle: config.forcePathStyle,
        }),
        kind: "s3",
        retentionDays: Math.max(0, settings.retentionDays),
      });
    }
  }

  if (env.STORAGE_DRIVER === "r2" && envS3Available()) {
    return cacheSet("global", {
      driver: createS3Storage(envS3Config()),
      kind: "s3",
      retentionDays: Math.max(0, settings.retentionDays),
    });
  }

  return cacheSet("global", {
    driver: new LocalStorageDriver(env.STORAGE_LOCAL_DIR, env.PUBLIC_API_URL),
    kind: "local",
    retentionDays: 0,
  });
}

/**
 * Resolution order is frozen: a workspace with Google Drive credentials stores everything in its
 * own Drive (never auto-purged); otherwise the global driver applies.
 */
export async function resolveStorage(workspaceId: string | null): Promise<ResolvedStorage> {
  if (!workspaceId) return globalStorage();

  const cached = cacheGet(workspaceId);
  if (cached) return cached;

  const [row] = await db
    .select()
    .from(workspaceStorage)
    .where(eq(workspaceStorage.workspaceId, workspaceId))
    .limit(1);

  if (row && row.refreshTokenEncrypted.length > 0 && row.folderId.length > 0) {
    return cacheSet(workspaceId, {
      driver: new GDriveStorageDriver({
        folderId: row.folderId,
        getAccessToken: () => accessTokenFor(row.workspaceId),
      }),
      kind: "gdrive",
      retentionDays: 0,
    });
  }

  return globalStorage();
}

export function buildS3DriverFromInput(input: {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl: string;
  forcePathStyle: boolean;
}): StorageDriver {
  return createS3Storage(input);
}

function hmacKey(): Buffer {
  const raw = env.APP_ENCRYPTION_KEY;
  const bytes = Buffer.from(raw, "base64");
  if (bytes.length !== 32) {
    throw new Error("APP_ENCRYPTION_KEY is required to sign media URLs.");
  }
  return bytes;
}

/** URLs stay valid for `ttlSeconds` but only change once per hour bucket, so the browser's
 * immutable cache survives reloads; the expiry is always at or after `now + ttlSeconds`. */
const MEDIA_URL_BUCKET_SECONDS = 3600;

export function signMediaUrl(key: string, ttlSeconds: number): string {
  const now = Math.floor(Date.now() / 1000);
  const exp = Math.ceil((now + ttlSeconds) / MEDIA_URL_BUCKET_SECONDS) * MEDIA_URL_BUCKET_SECONDS;
  const sig = base64url(createHmac("sha256", hmacKey()).update(`${key}:${exp}`).digest());
  const base = env.PUBLIC_API_URL.replace(/\/+$/, "");
  return `${base}/media/${key}?exp=${exp}&sig=${sig}`;
}

export function verifyMediaSignature(key: string, exp: number, sig: string): boolean {
  if (!Number.isFinite(exp) || exp * 1000 <= Date.now()) return false;
  const expected = base64url(createHmac("sha256", hmacKey()).update(`${key}:${exp}`).digest());
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function base64url(value: Buffer): string {
  return value.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** `uploads/` and `generations/` keys are capability URLs: the signature replaces a session. */
export function isSignedKey(key: string): boolean {
  return /(^|\/)(uploads|generations)\//.test(key);
}

export function isPublicGenerationKey(key: string): boolean {
  return /(^|\/)generations\//.test(key);
}

function absoluteUrl(driver: StorageDriver, key: string): string {
  const url = driver.url(key);
  if (url.startsWith("http")) return url;
  return `${env.PUBLIC_API_URL}/media/${key}`;
}

/**
 * URLs are derived at read time, never stored: `uploads/` and `generations/` keys are signed through
 * the API host, while any other key falls back to the driver's own URL. The S3 `publicBaseUrl` is
 * therefore never baked into a row, so moving hosts cannot strand old renders.
 */
export function publicUrlFor(key: string, driver: StorageDriver): string {
  if (isSignedKey(key)) return signMediaUrl(key, env.MEDIA_URL_TTL_SECONDS);
  return absoluteUrl(driver, key);
}

/** Read-time URL of a rendered generation; `null` until the worker stored the output. */
export function outputUrlFor(row: Pick<GenerationRow, "outputKey">): string | null {
  return row.outputKey ? signMediaUrl(row.outputKey, env.MEDIA_URL_TTL_SECONDS) : null;
}

export async function urlForAsset(asset: MediaAssetRow): Promise<string> {
  if (asset.driver === "gdrive" && asset.externalId) return gdriveDownloadUrl(asset.externalId);
  const storage = await resolveStorage(asset.workspaceId);
  return publicUrlFor(asset.key, storage.driver);
}

export interface PutAssetResult {
  asset: MediaAssetRow;
  url: string;
}

export async function putAsset(
  workspaceId: string | null,
  key: string,
  bytes: Buffer,
  mime: string,
  meta: AssetMeta = {},
): Promise<PutAssetResult> {
  const storage = await resolveStorage(workspaceId);
  const { externalId } = await storage.driver.put(key, bytes, mime);

  const expiresAt =
    storage.retentionDays > 0
      ? new Date(Date.now() + storage.retentionDays * 24 * 60 * 60 * 1000)
      : null;

  const [asset] = await db
    .insert(mediaAssets)
    .values({
      workspaceId,
      key,
      mime,
      size: bytes.byteLength,
      driver: storage.kind,
      externalId: externalId ?? null,
      width: meta.width ?? null,
      height: meta.height ?? null,
      durationMs: meta.durationMs ?? null,
      checksum: meta.checksum ?? null,
      uploadedBy: meta.uploadedBy ?? null,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: mediaAssets.key,
      set: {
        workspaceId,
        mime,
        size: bytes.byteLength,
        driver: storage.kind,
        externalId: externalId ?? null,
        purgedAt: null,
        expiresAt,
      },
    })
    .returning();
  if (!asset) throw new Error("Failed to record the media asset.");

  return { asset, url: publicUrlFor(key, storage.driver) };
}

export async function removeAsset(asset: MediaAssetRow): Promise<void> {
  const storage = await resolveStorage(asset.workspaceId);
  try {
    await storage.driver.remove(asset.key, asset.externalId);
  } catch (error) {
    logger.warn({ err: error, key: asset.key }, "storage remove failed");
  }
  await db.update(mediaAssets).set({ purgedAt: new Date() }).where(eq(mediaAssets.id, asset.id));
}

/** Purges expired assets outside Google Drive workspaces; Drive media is never auto-deleted. */
export async function purgeExpiredMedia(limit: number): Promise<{ purged: number }> {
  const rows = await db
    .select()
    .from(mediaAssets)
    .where(
      and(
        isNotNull(mediaAssets.expiresAt),
        lt(mediaAssets.expiresAt, new Date()),
        isNull(mediaAssets.purgedAt),
        sql`${mediaAssets.driver} <> 'gdrive'`,
      ),
    )
    .limit(limit);

  let purged = 0;
  for (const asset of rows) {
    await removeAsset(asset);
    purged += 1;
  }
  return { purged };
}

export interface StorageUsage {
  active: number;
  bytes: number;
  expired: number;
}

export async function storageUsage(): Promise<StorageUsage> {
  const [row] = await db
    .select({
      active: sql<number>`count(*) filter (where ${mediaAssets.purgedAt} is null)`.mapWith(Number),
      bytes: sql<number>`coalesce(sum(${mediaAssets.size}) filter (where ${mediaAssets.purgedAt} is null), 0)`.mapWith(Number),
      expired: sql<number>`count(*) filter (where ${mediaAssets.purgedAt} is not null)`.mapWith(Number),
    })
    .from(mediaAssets);
  return row ?? { active: 0, bytes: 0, expired: 0 };
}

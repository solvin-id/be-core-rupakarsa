import { randomBytes } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { roleAtLeast } from "../auth/middleware.js";
import { decryptSecret, encryptSecret } from "../crypto/encryption.js";
import { db } from "../db/client.js";
import { workspaceMemberships, workspaceStorage } from "../db/schema.js";
import type { WorkspaceStorageRow } from "../db/schema.js";
import { env } from "../env.js";
import { AppError, forbidden, notFound, validation } from "../http/errors.js";
import { logger } from "../logger.js";
import { deleteChallenge, putChallenge, readChallenge } from "./challenge-store.js";
import {
  buildAuthUrl,
  ensureRupakarsaFolder,
  exchangeCode,
  fetchGoogleEmail,
  redirectUri,
  refreshAccessToken,
  revokeToken,
} from "./google-oauth-service.js";
import type { GoogleOAuthConfig } from "./google-oauth-service.js";
import { getRawStorageSettings, getStorageSettings, googleOAuthConfigured } from "./settings.js";
import { clearStorageCache } from "./storage-service.js";

const STATE_TTL_SECONDS = 600;
const ACCESS_TOKEN_SKEW_MS = 60_000;

interface DriveStatePayload {
  workspaceId: string;
  userId: string;
}

export interface WorkspaceDriveStatus {
  connected: boolean;
  oauthConfigured: boolean;
  googleEmail: string;
  folderId: string;
  folderName: string;
  folderUrl: string;
  connectedAt: string | null;
  lastError: string | null;
  defaultStorage: { kind: "s3" | "local"; retentionDays: number };
}

function folderUrl(folderId: string): string {
  return folderId.length > 0 ? `https://drive.google.com/drive/folders/${folderId}` : "";
}

function isConnected(row: WorkspaceStorageRow | undefined): boolean {
  return Boolean(row && row.refreshTokenEncrypted.length > 0 && row.folderId.length > 0);
}

async function loadRow(workspaceId: string): Promise<WorkspaceStorageRow | undefined> {
  const [row] = await db
    .select()
    .from(workspaceStorage)
    .where(eq(workspaceStorage.workspaceId, workspaceId))
    .limit(1);
  return row;
}

async function oauthConfigFromSettings(): Promise<GoogleOAuthConfig> {
  const settings = await getRawStorageSettings(db);
  if (!googleOAuthConfigured(settings)) {
    throw new AppError(
      409,
      "GDRIVE_NOT_CONFIGURED",
      "Google OAuth belum dikonfigurasi. Setel Client ID dan Client Secret di CMS → Storage.",
    );
  }
  return {
    clientId: settings.gdrive.clientId.trim(),
    clientSecret: decryptSecret(settings.gdrive.clientSecretEncrypted),
  };
}

async function defaultStorageKind(): Promise<WorkspaceDriveStatus["defaultStorage"]> {
  const settings = await getStorageSettings(db);
  if (settings.driver === "s3") {
    return { kind: "s3", retentionDays: Math.max(0, settings.retentionDays) };
  }
  return { kind: "local", retentionDays: 0 };
}

export async function startDriveConnect(
  workspaceId: string,
  userId: string,
): Promise<{ url: string }> {
  const config = await oauthConfigFromSettings();
  const state = randomBytes(32).toString("base64url");
  await putChallenge(state, { workspaceId, userId } satisfies DriveStatePayload, STATE_TTL_SECONDS);
  return { url: buildAuthUrl(config, redirectUri(), state) };
}

/**
 * The OAuth `state` nonce is the CSRF token here: the callback carries no session cookie, so the
 * stored challenge is what proves the consent started from this workspace by this user.
 */
export async function completeDriveConnect(
  state: string,
  code: string | null,
  error: string | null,
): Promise<{ workspaceId: string }> {
  const payload = await readChallenge<DriveStatePayload>(state);
  if (!payload) {
    throw validation("Sesi otorisasi Google tidak valid atau kedaluwarsa.");
  }
  await deleteChallenge(state);

  if (error) {
    throw validation("Akses Google Drive dibatalkan.");
  }
  if (!code) {
    throw validation("Google tidak mengirim kode otorisasi.");
  }

  const [membership] = await db
    .select()
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, payload.workspaceId),
        eq(workspaceMemberships.userId, payload.userId),
      ),
    )
    .limit(1);
  if (!membership || !roleAtLeast(membership.role, "ADMIN")) {
    throw forbidden("Hanya owner atau admin yang dapat menghubungkan Google Drive.");
  }

  const config = await oauthConfigFromSettings();
  const tokens = await exchangeCode(config, code, redirectUri());
  const googleEmail = await fetchGoogleEmail(tokens.accessToken);
  const folder = await ensureRupakarsaFolder(tokens.accessToken);

  const values = {
    googleEmail,
    refreshTokenEncrypted: encryptSecret(tokens.refreshToken),
    accessTokenEncrypted: encryptSecret(tokens.accessToken),
    accessTokenExpiresAt: tokens.expiresAt,
    scope: tokens.scope,
    folderId: folder.folderId,
    folderName: folder.folderName,
    connectedByUserId: payload.userId,
    connectedAt: new Date(),
    updatedAt: new Date(),
    lastError: null,
  };

  await db
    .insert(workspaceStorage)
    .values({ workspaceId: payload.workspaceId, ...values })
    .onConflictDoUpdate({ target: workspaceStorage.workspaceId, set: values });
  clearStorageCache();

  return { workspaceId: payload.workspaceId };
}

export async function getDriveStatus(workspaceId: string): Promise<WorkspaceDriveStatus> {
  const [row, settings, defaultStorage] = await Promise.all([
    loadRow(workspaceId),
    getRawStorageSettings(db),
    defaultStorageKind(),
  ]);

  return {
    connected: isConnected(row),
    oauthConfigured: googleOAuthConfigured(settings),
    googleEmail: row?.googleEmail ?? "",
    folderId: row?.folderId ?? "",
    folderName: row?.folderName ?? "Rupakarsa",
    folderUrl: folderUrl(row?.folderId ?? ""),
    connectedAt: row?.connectedAt ? row.connectedAt.toISOString() : null,
    lastError: row?.lastError ?? null,
    defaultStorage,
  };
}

/** Returns a usable Drive access token, refreshing (and persisting) it when the stored one expired. */
export async function accessTokenFor(
  workspaceId: string,
): Promise<{ token: string; expiresAt: number }> {
  const row = await loadRow(workspaceId);
  if (!isConnected(row) || !row) {
    throw new AppError(409, "GDRIVE_NOT_CONNECTED", "Google Drive workspace belum terhubung.");
  }

  const storedExpiry = row.accessTokenExpiresAt?.getTime() ?? 0;
  if (row.accessTokenEncrypted.length > 0 && storedExpiry - ACCESS_TOKEN_SKEW_MS > Date.now()) {
    return { token: decryptSecret(row.accessTokenEncrypted), expiresAt: storedExpiry };
  }

  const config = await oauthConfigFromSettings();
  let storedRefreshToken: string;
  try {
    storedRefreshToken = decryptSecret(row.refreshTokenEncrypted);
  } catch {
    // A rotated APP_ENCRYPTION_KEY leaves unreadable tokens: ask for a fresh consent.
    const unrecoverable = new AppError(
      502,
      "STORAGE_ERROR",
      "Sesi Google Drive kedaluwarsa. Hubungkan ulang dari Kelola workspace.",
    );
    await persistLastError(workspaceId, unrecoverable);
    throw unrecoverable;
  }

  try {
    const refreshed = await refreshAccessToken(config, storedRefreshToken);
    const expiresAt = refreshed.expiresAt.getTime();
    await db
      .update(workspaceStorage)
      .set({
        accessTokenEncrypted: encryptSecret(refreshed.accessToken),
        accessTokenExpiresAt: refreshed.expiresAt,
        ...(refreshed.refreshToken
          ? { refreshTokenEncrypted: encryptSecret(refreshed.refreshToken) }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(workspaceStorage.workspaceId, workspaceId));
    return { token: refreshed.accessToken, expiresAt };
  } catch (refreshFailure) {
    await persistLastError(workspaceId, refreshFailure);
    throw refreshFailure;
  }
}

async function persistLastError(workspaceId: string, failure: unknown): Promise<void> {
  const message = failure instanceof Error ? failure.message : "Google Drive tidak dapat dihubungi.";
  await db
    .update(workspaceStorage)
    .set({ lastError: message, updatedAt: new Date() })
    .where(eq(workspaceStorage.workspaceId, workspaceId));
}

export async function testDriveConnection(
  workspaceId: string,
): Promise<{ ok: boolean; message: string }> {
  const row = await loadRow(workspaceId);
  if (!isConnected(row) || !row) throw notFound("Google Drive belum terhubung.");

  try {
    const { token } = await accessTokenFor(workspaceId);
    const response = await fetch(
      `${env.GOOGLE_DRIVE_API_URL}/files/${encodeURIComponent(row.folderId)}?fields=id,name`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) },
    );
    if (!response.ok) {
      throw new AppError(
        502,
        "STORAGE_ERROR",
        `Google Drive menolak folder Rupakarsa (${response.status}).`,
      );
    }
    await db
      .update(workspaceStorage)
      .set({ lastError: null, updatedAt: new Date() })
      .where(eq(workspaceStorage.workspaceId, workspaceId));
    return { ok: true, message: "Google Drive terhubung." };
  } catch (failure) {
    await persistLastError(workspaceId, failure);
    return {
      ok: false,
      message: failure instanceof Error ? failure.message : "Google Drive tidak dapat dihubungi.",
    };
  }
}

export async function disconnectDrive(workspaceId: string): Promise<void> {
  const row = await loadRow(workspaceId);
  if (row && row.refreshTokenEncrypted.length > 0) {
    // Revoking is best effort: a rotated encryption key must never block disconnecting.
    try {
      await revokeToken(decryptSecret(row.refreshTokenEncrypted));
    } catch (failure) {
      logger.warn({ err: failure, workspaceId }, "gdrive revoke skipped");
    }
  }
  await db.delete(workspaceStorage).where(eq(workspaceStorage.workspaceId, workspaceId));
  clearStorageCache();
}

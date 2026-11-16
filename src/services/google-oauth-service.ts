import { env } from "../env.js";
import { AppError } from "../http/errors.js";

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
}

export interface GoogleTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scope: string;
}

export interface RefreshedTokenSet {
  accessToken: string;
  expiresAt: Date;
  refreshToken?: string;
}

export const GDRIVE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/drive.file",
] as const;

const FOLDER_NAME = "Rupakarsa";
const REQUEST_TIMEOUT_MS = 15_000;

export function redirectUri(): string {
  return `${env.PUBLIC_API_URL.replace(/\/$/, "")}/api/public/google/oauth/callback`;
}

export function buildAuthUrl(cfg: GoogleOAuthConfig, callbackUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: callbackUri,
    response_type: "code",
    scope: GDRIVE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `${env.GOOGLE_OAUTH_AUTH_URL}?${params.toString()}`;
}

function tokenError(): AppError {
  return new AppError(
    502,
    "STORAGE_ERROR",
    "Google menolak kode otorisasi. Coba hubungkan ulang.",
  );
}

function refreshError(): AppError {
  return new AppError(
    502,
    "STORAGE_ERROR",
    "Sesi Google Drive kedaluwarsa. Hubungkan ulang dari Kelola workspace.",
  );
}

async function postForm(url: string, body: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

function expiresAtFrom(expiresIn: unknown): Date {
  const seconds = typeof expiresIn === "number" && expiresIn > 0 ? expiresIn : 3600;
  return new Date(Date.now() + seconds * 1000);
}

export async function exchangeCode(
  cfg: GoogleOAuthConfig,
  code: string,
  callbackUri: string,
): Promise<GoogleTokenSet> {
  const response = await postForm(env.GOOGLE_OAUTH_TOKEN_URL, {
    grant_type: "authorization_code",
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: callbackUri,
  });
  if (!response.ok) throw tokenError();

  const payload = (await response.json()) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    scope?: unknown;
  };
  if (typeof payload.access_token !== "string" || payload.access_token.length === 0) {
    throw tokenError();
  }
  if (typeof payload.refresh_token !== "string" || payload.refresh_token.length === 0) {
    // Without a refresh token the connection dies when the access token expires.
    throw tokenError();
  }

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: expiresAtFrom(payload.expires_in),
    scope: typeof payload.scope === "string" ? payload.scope : GDRIVE_SCOPES.join(" "),
  };
}

export async function refreshAccessToken(
  cfg: GoogleOAuthConfig,
  refreshToken: string,
): Promise<RefreshedTokenSet> {
  const response = await postForm(env.GOOGLE_OAUTH_TOKEN_URL, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  });
  if (!response.ok) throw refreshError();

  const payload = (await response.json()) as {
    access_token?: unknown;
    expires_in?: unknown;
    refresh_token?: unknown;
  };
  if (typeof payload.access_token !== "string" || payload.access_token.length === 0) {
    throw refreshError();
  }

  return {
    accessToken: payload.access_token,
    expiresAt: expiresAtFrom(payload.expires_in),
    refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token : undefined,
  };
}

export async function fetchGoogleEmail(accessToken: string): Promise<string> {
  const response = await fetch(env.GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new AppError(502, "STORAGE_ERROR", "Google menolak akses profil akun.");
  }

  const payload = (await response.json()) as { email?: unknown };
  const email = typeof payload.email === "string" ? payload.email.trim() : "";
  if (email.length === 0) {
    throw new AppError(502, "STORAGE_ERROR", "Google tidak mengembalikan email akun.");
  }
  return email;
}

/**
 * Reuses an existing non-trashed `Rupakarsa` folder at Drive root so reconnecting a workspace never
 * creates a second folder. Only folders this app created are visible with the `drive.file` scope.
 */
export async function ensureRupakarsaFolder(
  accessToken: string,
): Promise<{ folderId: string; folderName: string }> {
  const query = new URLSearchParams({
    q: "name='Rupakarsa' and mimeType='application/vnd.google-apps.folder' and 'root' in parents and trashed=false",
    fields: "files(id,name)",
  });
  const list = await fetch(`${env.GOOGLE_DRIVE_API_URL}/files?${query.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!list.ok) {
    throw new AppError(502, "STORAGE_ERROR", "Google Drive tidak dapat dibaca. Coba hubungkan ulang.");
  }

  const listed = (await list.json()) as { files?: Array<{ id?: unknown }> };
  const existing = listed.files?.find(
    (file) => typeof file.id === "string" && file.id.length > 0,
  );
  if (existing && typeof existing.id === "string") {
    return { folderId: existing.id, folderName: FOLDER_NAME };
  }

  const created = await fetch(`${env.GOOGLE_DRIVE_API_URL}/files`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      name: FOLDER_NAME,
      mimeType: "application/vnd.google-apps.folder",
      parents: ["root"],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!created.ok) {
    throw new AppError(502, "STORAGE_ERROR", "Google Drive menolak pembuatan folder Rupakarsa.");
  }

  const folder = (await created.json()) as { id?: unknown };
  if (typeof folder.id !== "string" || folder.id.length === 0) {
    throw new AppError(502, "STORAGE_ERROR", "Google Drive tidak mengembalikan id folder.");
  }
  return { folderId: folder.id, folderName: FOLDER_NAME };
}

/** Best effort: a revoked token still gets its local row deleted. */
export async function revokeToken(token: string): Promise<void> {
  try {
    await fetch(`${env.GOOGLE_REVOKE_URL}?token=${encodeURIComponent(token)}`, {
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    // Network failure during revoke must never block disconnecting the workspace.
  }
}

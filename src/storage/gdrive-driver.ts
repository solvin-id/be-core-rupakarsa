import { createSign } from "node:crypto";
import { basename } from "node:path";

import type { PutResult, StorageDriver, StoredObject } from "../adapters/types.js";
import { AppError } from "../http/errors.js";
import { assertSafeKey, mimeFor } from "./local-driver.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const SCOPE = "https://www.googleapis.com/auth/drive";

export interface GDriveConfig {
  serviceAccountEmail: string;
  privateKey: string;
  folderId: string;
}

export interface ParsedServiceAccount {
  serviceAccountEmail: string;
  privateKey: string;
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Accepts the raw service-account JSON (or its parsed shape). Newlines in the private key survive
 * the `\n` escaping that pasting into a textarea introduces.
 */
export function parseServiceAccountJson(raw: string): ParsedServiceAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AppError(400, "VALIDATION_ERROR", "Isi JSON service account tidak valid.");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new AppError(400, "VALIDATION_ERROR", "Isi JSON service account tidak valid.");
  }
  const record = parsed as { client_email?: unknown; private_key?: unknown };
  const serviceAccountEmail = typeof record.client_email === "string" ? record.client_email.trim() : "";
  const privateKeyRaw = typeof record.private_key === "string" ? record.private_key : "";
  const privateKey = privateKeyRaw.replace(/\\n/g, "\n").trim();

  if (serviceAccountEmail.length === 0 || !privateKey.includes("PRIVATE KEY")) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "JSON service account wajib memuat client_email dan private_key.",
    );
  }
  return { serviceAccountEmail, privateKey };
}

export class GDriveStorageDriver implements StorageDriver {
  private readonly config: GDriveConfig;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(config: GDriveConfig) {
    this.config = config;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - 60_000 > Date.now()) return this.token.value;

    const issuedAt = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claim = base64url(
      JSON.stringify({
        iss: this.config.serviceAccountEmail,
        scope: SCOPE,
        aud: TOKEN_URL,
        exp: issuedAt + 3600,
        iat: issuedAt,
      }),
    );

    let signature: string;
    try {
      const signer = createSign("RSA-SHA256");
      signer.update(`${header}.${claim}`);
      signature = base64url(signer.sign(this.config.privateKey));
    } catch {
      throw new AppError(502, "STORAGE_ERROR", "Private key service account tidak dapat dipakai.");
    }

    const assertion = `${header}.${claim}.${signature}`;
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw new AppError(502, "STORAGE_ERROR", `Google menolak kredensial (${response.status}).`);
    }
    const payload = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof payload.access_token !== "string") {
      throw new AppError(502, "STORAGE_ERROR", "Google tidak mengembalikan access token.");
    }
    const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 3600;
    this.token = { value: payload.access_token, expiresAt: Date.now() + expiresIn * 1000 };
    return payload.access_token;
  }

  async put(key: string, bytes: Buffer, mime: string): Promise<PutResult> {
    assertSafeKey(key);
    const token = await this.accessToken();
    const boundary = `rupakarsa${Date.now().toString(16)}`;
    const metadata = JSON.stringify({ name: basename(key), parents: [this.config.folderId] });

    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`,
        "utf8",
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
    ]);

    const response = await fetch(`${DRIVE_UPLOAD}?uploadType=multipart&fields=id,name`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new AppError(502, "STORAGE_ERROR", `Google Drive menolak unggahan: ${detail.slice(0, 200)}`);
    }

    const file = (await response.json()) as { id?: unknown };
    if (typeof file.id !== "string") {
      throw new AppError(502, "STORAGE_ERROR", "Google Drive tidak mengembalikan id berkas.");
    }

    // Rendered media is embedded in <img>/<video> tags, so the file must be readable by link.
    const permission = await fetch(`${DRIVE_API}/${file.id}/permissions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ role: "reader", type: "anyone" }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!permission.ok) {
      const detail = await permission.text();
      throw new AppError(
        502,
        "STORAGE_ERROR",
        `Google Drive menolak izin publik: ${detail.slice(0, 200)}`,
      );
    }

    return { externalId: file.id };
  }

  url(): string {
    throw new Error("Use urlForAsset for the gdrive driver.");
  }

  async read(_key: string, externalId?: string | null): Promise<StoredObject | null> {
    if (!externalId) return null;
    const token = await this.accessToken();
    const response = await fetch(`${DRIVE_API}/${externalId}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    return {
      bytes,
      mime: response.headers.get("content-type") ?? mimeFor(_key),
    };
  }

  async remove(_key: string, externalId?: string | null): Promise<void> {
    if (!externalId) return;
    const token = await this.accessToken();
    const response = await fetch(`${DRIVE_API}/${externalId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.ok || response.status === 404) return;
    throw new AppError(502, "STORAGE_ERROR", `Google Drive gagal menghapus berkas (${response.status}).`);
  }

  /** Writes and deletes a probe object so a frozen credential would fail before it is stored. */
  async probe(): Promise<void> {
    const key = `_probe/${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 8)}.txt`;
    const { externalId } = await this.put(key, Buffer.from("rupakarsa", "utf8"), "text/plain");
    await this.remove(key, externalId);
  }
}

export function gdriveDownloadUrl(externalId: string): string {
  return `https://drive.google.com/uc?export=download&id=${externalId}`;
}

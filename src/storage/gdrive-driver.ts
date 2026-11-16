import { basename } from "node:path";

import type { PutResult, StorageDriver, StoredObject } from "../adapters/types.js";
import { env } from "../env.js";
import { AppError } from "../http/errors.js";
import { assertSafeKey, mimeFor } from "./local-driver.js";

const TOKEN_SKEW_MS = 60_000;

export interface GDriveDriverOptions {
  folderId: string;
  getAccessToken: () => Promise<{ token: string; expiresAt: number }>;
}

/**
 * Per-workspace Drive driver: every call runs under the workspace owner's OAuth token, scoped to
 * `drive.file`, so only files this app created are reachable.
 */
export class GDriveStorageDriver implements StorageDriver {
  private readonly options: GDriveDriverOptions;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(options: GDriveDriverOptions) {
    this.options = options;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - TOKEN_SKEW_MS > Date.now()) return this.token.value;
    const issued = await this.options.getAccessToken();
    this.token = { value: issued.token, expiresAt: issued.expiresAt };
    return issued.token;
  }

  async put(key: string, bytes: Buffer, mime: string): Promise<PutResult> {
    assertSafeKey(key);
    const token = await this.accessToken();
    const boundary = `rupakarsa${Date.now().toString(16)}`;
    const metadata = JSON.stringify({ name: basename(key), parents: [this.options.folderId] });

    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`,
        "utf8",
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
    ]);

    const response = await fetch(`${env.GOOGLE_DRIVE_UPLOAD_URL}/files?uploadType=multipart&fields=id,name`, {
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
    const permission = await fetch(`${env.GOOGLE_DRIVE_API_URL}/files/${file.id}/permissions`, {
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

  async read(key: string, externalId?: string | null): Promise<StoredObject | null> {
    if (!externalId) return null;
    const token = await this.accessToken();
    const response = await fetch(`${env.GOOGLE_DRIVE_API_URL}/files/${externalId}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    return {
      bytes,
      mime: response.headers.get("content-type") ?? mimeFor(key),
    };
  }

  async remove(key: string, externalId?: string | null): Promise<void> {
    if (!externalId) return;
    const token = await this.accessToken();
    const response = await fetch(`${env.GOOGLE_DRIVE_API_URL}/files/${externalId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.ok || response.status === 404) return;
    throw new AppError(502, "STORAGE_ERROR", `Google Drive gagal menghapus berkas (${response.status}).`);
  }
}

export function gdriveDownloadUrl(externalId: string): string {
  return `https://drive.google.com/uc?export=download&id=${externalId}`;
}

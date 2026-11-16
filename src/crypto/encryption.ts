import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { env } from "../env.js";

const VERSION = "v1";
const IV_BYTES = 12;

function key(): Buffer {
  const raw = env.APP_ENCRYPTION_KEY;
  if (raw.length === 0) {
    throw new Error("APP_ENCRYPTION_KEY is not configured; provider secrets cannot be stored.");
  }
  const bytes = Buffer.from(raw, "base64");
  if (bytes.length !== 32) {
    throw new Error("APP_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  }
  return bytes;
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptSecret(payload: string): string {
  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("Encrypted secret has an unknown format.");
  }
  const [, ivRaw, tagRaw, dataRaw] = parts;
  if (!ivRaw || !tagRaw || !dataRaw) throw new Error("Encrypted secret is malformed.");

  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivRaw, "base64"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataRaw, "base64")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

export function maskSecret(plain: string): string {
  if (plain.length <= 6) return "•".repeat(8);
  return `${plain.slice(0, 3)}${"•".repeat(8)}${plain.slice(-4)}`;
}

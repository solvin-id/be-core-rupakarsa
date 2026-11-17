import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type {
  ByteRange,
  PutResult,
  StorageDriver,
  StoredObject,
  StoredObjectMeta,
  StoredRange,
} from "../adapters/types.js";

const KEY_PATTERN = /^[a-zA-Z0-9/_.-]+$/;

export function assertSafeKey(key: string): void {
  if (!KEY_PATTERN.test(key) || key.includes("..")) {
    throw new Error(`Unsafe storage key: ${key}`);
  }
}

export class LocalStorageDriver implements StorageDriver {
  private readonly root: string;
  private readonly publicBase: string;

  constructor(rootDir: string, publicBase: string) {
    this.root = resolve(rootDir);
    this.publicBase = publicBase.replace(/\/+$/, "");
  }

  private resolveKey(key: string): string {
    assertSafeKey(key);
    return join(this.root, key);
  }

  async put(key: string, bytes: Buffer, _mime: string): Promise<PutResult> {
    const target = this.resolveKey(key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { mode: 0o600 });
    return {};
  }

  url(key: string): string {
    return `${this.publicBase}/media/${key}`;
  }

  async read(key: string): Promise<StoredObject | null> {
    let target: string;
    try {
      target = this.resolveKey(key);
    } catch {
      return null;
    }
    try {
      const bytes = await readFile(target);
      return { bytes, mime: mimeFor(key) };
    } catch {
      return null;
    }
  }

  async stat(key: string): Promise<StoredObjectMeta | null> {
    let target: string;
    try {
      target = this.resolveKey(key);
    } catch {
      return null;
    }
    try {
      const info = await stat(target);
      if (!info.isFile()) return null;
      return { size: info.size, mime: mimeFor(key) };
    } catch {
      return null;
    }
  }

  async readRange(key: string, range: ByteRange): Promise<StoredRange | null> {
    const meta = await this.stat(key);
    if (!meta) return null;

    const start = Math.max(0, Math.min(range.start, meta.size - 1));
    const end = Math.max(start, Math.min(range.end, meta.size - 1));
    const length = end - start + 1;

    const handle = await open(this.resolveKey(key), "r");
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      return { bytes: buffer, mime: meta.mime, size: meta.size };
    } finally {
      await handle.close();
    }
  }

  async remove(key: string): Promise<void> {
    let target: string;
    try {
      target = this.resolveKey(key);
    } catch {
      return;
    }
    await rm(target, { force: true });
  }
}

export function mimeFor(key: string): string {
  if (key.endsWith(".svg")) return "image/svg+xml";
  if (key.endsWith(".png")) return "image/png";
  if (key.endsWith(".jpg") || key.endsWith(".jpeg")) return "image/jpeg";
  if (key.endsWith(".webp")) return "image/webp";
  if (key.endsWith(".mp4")) return "video/mp4";
  if (key.endsWith(".webm")) return "video/webm";
  return "application/octet-stream";
}

import { basename } from "node:path";

import { eq } from "drizzle-orm";
import { OpenAPIHono } from "@hono/zod-openapi";

import { readSession } from "../auth/session.js";
import { db } from "../db/client.js";
import { mediaAssets } from "../db/schema.js";
import { notFound } from "../http/errors.js";
import { defaultHook } from "../http/route-helpers.js";
import type { AppBindings } from "../http/types.js";
import {
  isSignedKey,
  resolveStorage,
  verifyMediaSignature,
} from "../services/storage-service.js";

export const mediaRoutes = new OpenAPIHono<AppBindings>({ defaultHook });

/** Storage keys are multi-segment (`workspaces/<id>/generations/<id>.mp4`). */
const KEY_PATTERN = /^[A-Za-z0-9/_.-]+$/;
const RANGE_PATTERN = /^bytes=(\d*)-(\d*)$/;

interface ParsedRange {
  start: number;
  end: number | null;
}

function parseRange(header: string | undefined): ParsedRange | null {
  if (!header) return null;
  const match = RANGE_PATTERN.exec(header.trim());
  if (!match) return null;
  const [, rawStart = "", rawEnd = ""] = match;
  if (rawStart.length === 0 && rawEnd.length === 0) return null;
  // A suffix range (`bytes=-500`) means "the last N bytes"; the caller resolves it against size.
  if (rawStart.length === 0) {
    const suffix = Number(rawEnd);
    return Number.isFinite(suffix) && suffix > 0 ? { start: -suffix, end: null } : null;
  }
  const start = Number(rawStart);
  const end = rawEnd.length > 0 ? Number(rawEnd) : null;
  if (!Number.isFinite(start)) return null;
  if (end !== null && (!Number.isFinite(end) || end < start)) return null;
  return { start, end };
}

/**
 * Rendered media is immutable but never public: `uploads/` and `generations/` keys carry a signed
 * `exp` + `sig` pair, which is the capability in place of a session — a `<video>` element and a
 * provider fetch cannot send cookies. Both support `Range` so playback streams and seeks.
 */
mediaRoutes.get("/media/*", async (c) => {
  const key = c.req.path.replace(/^\/media\//, "");
  if (key.length === 0 || !KEY_PATTERN.test(key) || key.includes("..")) {
    throw notFound("Media tidak ditemukan.");
  }

  const signedKey = isSignedKey(key);
  if (signedKey) {
    const exp = Number(c.req.query("exp") ?? "0");
    const sig = c.req.query("sig") ?? "";
    if (sig.length === 0 || !verifyMediaSignature(key, exp, sig)) {
      throw notFound("Media tidak ditemukan.");
    }
  }

  const [asset] = await db.select().from(mediaAssets).where(eq(mediaAssets.key, key)).limit(1);
  if (!asset) throw notFound("Media tidak ditemukan.");
  if (asset.purgedAt) throw notFound("Media tidak ditemukan.");

  if (!signedKey) {
    const session = await readSession(c);
    if (!session || !asset.workspaceId || asset.workspaceId !== session.activeWorkspaceId) {
      throw notFound("Media tidak ditemukan.");
    }
  }

  const storage = await resolveStorage(asset.workspaceId);
  const etag = `"${asset.id}-${asset.size}"`;
  const headers: Record<string, string> = {
    "Content-Type": asset.mime,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=31536000, immutable",
    Vary: "Cookie",
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
  };
  if (c.req.query("download") !== undefined) {
    headers["Content-Disposition"] = `attachment; filename="${basename(key)}"`;
  }

  // Revalidation happens before any driver call, so a cached client costs one row lookup.
  if (c.req.header("if-none-match") === etag) {
    return c.body(null, 304, headers);
  }

  const requested = parseRange(c.req.header("range"));

  if (requested && storage.driver.readRange && storage.driver.stat) {
    const meta = await storage.driver.stat(key, asset.externalId);
    if (!meta) throw notFound("Media tidak ditemukan.");

    const start = requested.start < 0 ? Math.max(0, meta.size + requested.start) : requested.start;
    const end = Math.min(requested.end ?? meta.size - 1, meta.size - 1);
    if (start > end) {
      return c.body(null, 416, { ...headers, "Content-Range": `bytes */${meta.size}` });
    }

    const slice = await storage.driver.readRange(
      key,
      { start, end },
      asset.externalId,
    );
    if (!slice) throw notFound("Media tidak ditemukan.");

    return c.body(new Uint8Array(slice.bytes), 206, {
      ...headers,
      "Content-Range": `bytes ${start}-${end}/${slice.size}`,
      "Content-Length": String(slice.bytes.byteLength),
    });
  }

  const object = await storage.driver.read(key, asset.externalId);
  if (!object) throw notFound("Media tidak ditemukan.");

  if (requested) {
    const size = object.bytes.byteLength;
    const start = requested.start < 0 ? Math.max(0, size + requested.start) : requested.start;
    const end = Math.min(requested.end ?? size - 1, size - 1);
    if (start > end) {
      return c.body(null, 416, { ...headers, "Content-Range": `bytes */${size}` });
    }
    headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    headers["Content-Length"] = String(end - start + 1);
    return c.body(new Uint8Array(object.bytes.subarray(start, end + 1)), 206, headers);
  }

  headers["Content-Length"] = String(object.bytes.byteLength);
  return c.body(new Uint8Array(object.bytes), 200, headers);
});

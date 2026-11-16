import { basename } from "node:path";

import { eq } from "drizzle-orm";
import { OpenAPIHono } from "@hono/zod-openapi";

import { db } from "../db/client.js";
import { mediaAssets } from "../db/schema.js";
import { notFound } from "../http/errors.js";
import { defaultHook } from "../http/route-helpers.js";
import type { AppBindings } from "../http/types.js";
import {
  isPrivateKey,
  isPublicGenerationKey,
  resolveStorage,
  verifyMediaSignature,
} from "../services/storage-service.js";

export const mediaRoutes = new OpenAPIHono<AppBindings>({ defaultHook });

/**
 * Storage keys are multi-segment (`workspaces/<id>/generations/<id>.mp4`), so this is a wildcard
 * route rather than an OpenAPI-described parameter. Rendered media is public-immutable; uploads
 * always need the `exp` + `sig` pair produced by `signMediaUrl`.
 */
mediaRoutes.get("/media/*", async (c) => {
  const key = c.req.path.replace(/^\/media\//, "");
  if (key.length === 0) throw notFound("Media tidak ditemukan.");

  const privateKey = isPrivateKey(key);
  if (privateKey) {
    const exp = Number(c.req.query("exp") ?? "0");
    const sig = c.req.query("sig") ?? "";
    if (sig.length === 0 || !verifyMediaSignature(key, exp, sig)) {
      throw notFound("Media tidak ditemukan.");
    }
  }

  const [asset] = await db.select().from(mediaAssets).where(eq(mediaAssets.key, key)).limit(1);
  if (!asset) throw notFound("Media tidak ditemukan.");
  if (asset.purgedAt) throw notFound("Media tidak ditemukan.");

  const storage = await resolveStorage(asset.workspaceId);
  const object = await storage.driver.read(key, asset.externalId);
  if (!object) throw notFound("Media tidak ditemukan.");

  const headers: Record<string, string> = {
    "Content-Type": asset.mime || object.mime,
    "Cache-Control": isPublicGenerationKey(key)
      ? "public, max-age=31536000, immutable"
      : "private, max-age=0, no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (c.req.query("download") !== undefined) {
    headers["Content-Disposition"] = `attachment; filename="${basename(key)}"`;
  }

  return c.body(new Uint8Array(object.bytes), 200, headers);
});

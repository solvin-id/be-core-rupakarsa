import { basename } from "node:path";

import { eq } from "drizzle-orm";
import { OpenAPIHono } from "@hono/zod-openapi";

import { db } from "../db/client.js";
import { mediaAssets } from "../db/schema.js";
import { env } from "../env.js";
import { notFound } from "../http/errors.js";
import { defaultHook } from "../http/route-helpers.js";
import type { AppBindings } from "../http/types.js";
import { getStorage } from "../storage/index.js";

export const mediaRoutes = new OpenAPIHono<AppBindings>({ defaultHook });

/**
 * Storage keys are multi-segment (`generations/<id>.svg`, `uploads/<user>/<id>.png`), so this is a
 * wildcard route rather than an OpenAPI-described `:key` parameter. Binary passthrough is not part
 * of the generated client contract.
 */
mediaRoutes.get("/media/*", async (c) => {
  if (env.STORAGE_DRIVER !== "local") throw notFound("Media tidak tersedia melalui API.");

  const key = c.req.path.replace(/^\/media\//, "");
  if (key.length === 0) throw notFound("Media tidak ditemukan.");

  const storage = getStorage();
  const object = await storage.read(key);
  if (!object) throw notFound("Media tidak ditemukan.");

  const [asset] = await db
    .select({ mime: mediaAssets.mime })
    .from(mediaAssets)
    .where(eq(mediaAssets.key, key))
    .limit(1);

  const headers: Record<string, string> = {
    "Content-Type": asset?.mime ?? object.mime,
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
  };
  if (c.req.query("download") !== undefined) {
    headers["Content-Disposition"] = `attachment; filename="${basename(key)}"`;
  }

  return c.body(new Uint8Array(object.bytes), 200, headers);
});

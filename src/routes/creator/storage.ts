import { basename } from "node:path";

import { and, desc, eq, ilike, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { requireWorkspace, roleAtLeast, sessionGuard } from "../../auth/middleware.js";
import { db } from "../../db/client.js";
import { generations, mediaAssets } from "../../db/schema.js";
import type { MediaAssetRow } from "../../db/schema.js";
import { forbidden, notFound } from "../../http/errors.js";
import { defaultHook } from "../../http/route-helpers.js";
import {
  ErrorResponseSchema,
  StorageListSchema,
} from "../../http/schemas.js";
import type { AppBindings } from "../../http/types.js";
import { removeAsset, urlForAsset } from "../../services/storage-service.js";

export const creatorStorageRoutes = new OpenAPIHono<AppBindings>({ defaultHook });

const errorContent = { "application/json": { schema: ErrorResponseSchema } };
const assetParams = z.object({ assetId: z.string().uuid() });
const DEFAULT_LIMIT = 60;
const MAX_LIMIT = 100;
const GENERATION_KEY = /\/generations\/([0-9a-f-]{36})\.[a-z0-9]+$/;

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}_${id}`).toString("base64url");
}

function decodeCursor(raw: string): { createdAt: Date; id: string } | null {
  try {
    const text = Buffer.from(raw, "base64url").toString("utf8");
    const separator = text.lastIndexOf("_");
    if (separator <= 0) return null;
    const createdAt = new Date(text.slice(0, separator));
    const id = text.slice(separator + 1);
    if (Number.isNaN(createdAt.getTime()) || id.length === 0) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

function sourceOf(asset: MediaAssetRow): "UPLOAD" | "GENERATION" {
  return /\/generations\//.test(asset.key) ? "GENERATION" : "UPLOAD";
}

creatorStorageRoutes.use("/storage", sessionGuard(), requireWorkspace("MEMBER"));
creatorStorageRoutes.use("/storage/*", sessionGuard(), requireWorkspace("MEMBER"));

const listRoute = createRoute({
  method: "get",
  path: "/storage",
  tags: ["Creator storage"],
  request: {
    query: z.object({
      type: z.enum(["IMAGE", "VIDEO"]).optional(),
      source: z.enum(["UPLOAD", "GENERATION"]).optional(),
      q: z.string().optional(),
      cursor: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
    }),
  },
  responses: {
    200: { description: "Workspace media grid", content: { "application/json": { schema: StorageListSchema } } },
    400: { description: "Invalid cursor", content: errorContent },
  },
});

creatorStorageRoutes.openapi(listRoute, async (c) => {
  const auth = c.get("auth");
  const workspaceId = auth.workspaceId;
  if (!workspaceId) throw notFound("Workspace aktif tidak ditemukan.");

  const query = c.req.valid("query");
  const limit = query.limit ?? DEFAULT_LIMIT;

  const conditions = [eq(mediaAssets.workspaceId, workspaceId), isNull(mediaAssets.purgedAt)];
  if (query.type === "IMAGE") conditions.push(ilike(mediaAssets.mime, "image/%"));
  if (query.type === "VIDEO") conditions.push(ilike(mediaAssets.mime, "video/%"));
  if (query.source === "UPLOAD") conditions.push(ilike(mediaAssets.key, "%/uploads/%"));
  if (query.source === "GENERATION") conditions.push(ilike(mediaAssets.key, "%/generations/%"));
  if (query.q && query.q.trim().length > 0) {
    conditions.push(ilike(mediaAssets.key, `%${query.q.trim()}%`));
  }
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor);
    if (!cursor) {
      return c.json({ error: { code: "VALIDATION_ERROR", message: "Cursor tidak valid." } }, 400);
    }
    const keyset = or(
      lt(mediaAssets.createdAt, cursor.createdAt),
      and(eq(mediaAssets.createdAt, cursor.createdAt), lt(mediaAssets.id, cursor.id)),
    );
    if (keyset) conditions.push(keyset);
  }

  const rows = await db
    .select()
    .from(mediaAssets)
    .where(and(...conditions))
    .orderBy(desc(mediaAssets.createdAt), desc(mediaAssets.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null;

  const generationIds = page
    .map((asset) => GENERATION_KEY.exec(asset.key)?.[1])
    .filter((id): id is string => typeof id === "string");
  const generationRows =
    generationIds.length > 0
      ? await db
          .select({ id: generations.id, modelName: generations.modelName })
          .from(generations)
          .where(inArray(generations.id, generationIds))
      : [];
  const generationMap = new Map(generationRows.map((row) => [row.id, row.modelName]));

  const [totalsRow] = await db
    .select({
      count: sql<number>`count(*)`.mapWith(Number),
      bytes: sql<number>`coalesce(sum(${mediaAssets.size}), 0)`.mapWith(Number),
      images: sql<number>`count(*) filter (where ${mediaAssets.mime} like 'image/%')`.mapWith(Number),
      videos: sql<number>`count(*) filter (where ${mediaAssets.mime} like 'video/%')`.mapWith(Number),
    })
    .from(mediaAssets)
    .where(and(eq(mediaAssets.workspaceId, workspaceId), isNull(mediaAssets.purgedAt)));

  const items = await Promise.all(
    page.map(async (asset) => {
      const generationId = GENERATION_KEY.exec(asset.key)?.[1] ?? null;
      return {
        id: asset.id,
        key: asset.key,
        name: basename(asset.key),
        mime: asset.mime,
        size: asset.size,
        width: asset.width,
        height: asset.height,
        durationMs: asset.durationMs,
        driver: asset.driver as "local" | "s3" | "gdrive",
        source: sourceOf(asset),
        url: await urlForAsset(asset),
        generationId,
        modelName: generationId ? (generationMap.get(generationId) ?? null) : null,
        createdAt: asset.createdAt.toISOString(),
        purgedAt: asset.purgedAt ? asset.purgedAt.toISOString() : null,
      };
    }),
  );

  return c.json(
    {
      items,
      nextCursor,
      totals: {
        count: totalsRow?.count ?? 0,
        bytes: totalsRow?.bytes ?? 0,
        images: totalsRow?.images ?? 0,
        videos: totalsRow?.videos ?? 0,
      },
    },
    200,
  );
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/storage/{assetId}",
  tags: ["Creator storage"],
  request: { params: assetParams },
  responses: {
    204: { description: "Asset deleted" },
    403: { description: "Not the uploader or a workspace admin", content: errorContent },
    404: { description: "Asset not found", content: errorContent },
  },
});

creatorStorageRoutes.openapi(deleteRoute, async (c) => {
  const auth = c.get("auth");
  const workspaceId = auth.workspaceId;
  if (!workspaceId) throw notFound("Workspace aktif tidak ditemukan.");
  const membership = c.get("membership");
  const { assetId } = c.req.valid("param");

  const [asset] = await db
    .select()
    .from(mediaAssets)
    .where(and(eq(mediaAssets.id, assetId), eq(mediaAssets.workspaceId, workspaceId)))
    .limit(1);
  if (!asset) throw notFound("Aset tidak ditemukan.");

  const privileged = roleAtLeast(membership.role, "ADMIN");
  if (!privileged && asset.uploadedBy !== auth.user.id) {
    throw forbidden("Anda tidak dapat menghapus aset ini.");
  }

  await removeAsset(asset);
  return c.body(null, 204);
});

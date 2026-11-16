import { and, asc, eq } from "drizzle-orm";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { requireWorkspace, sessionGuard } from "../../auth/middleware.js";
import { db } from "../../db/client.js";
import { folderContexts, folders, generations } from "../../db/schema.js";
import type { FolderContextRow } from "../../db/schema.js";
import { notFound, validation } from "../../http/errors.js";
import { defaultHook } from "../../http/route-helpers.js";
import {
  ContextSourceSchema,
  ErrorResponseSchema,
  FolderContextSchema,
} from "../../http/schemas.js";
import type { AppBindings } from "../../http/types.js";
import { analyzeAsset } from "../../services/analysis-service.js";

export const creatorContextRoutes = new OpenAPIHono<AppBindings>({ defaultHook });

const errorContent = { "application/json": { schema: ErrorResponseSchema } };
const folderParams = z.object({ id: z.string().uuid() });
const contextParams = z.object({ contextId: z.string().uuid() });

creatorContextRoutes.use("/folders", sessionGuard(), requireWorkspace("MEMBER"));
creatorContextRoutes.use("/folders/*", sessionGuard(), requireWorkspace("MEMBER"));
creatorContextRoutes.use("/contexts", sessionGuard(), requireWorkspace("MEMBER"));
creatorContextRoutes.use("/contexts/*", sessionGuard(), requireWorkspace("MEMBER"));

function toContext(row: FolderContextRow) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    folderId: row.folderId,
    source: row.source,
    label: row.label,
    text: row.text,
    mediaAssetId: row.mediaAssetId,
    generationId: row.generationId,
    createdByUserId: row.createdByUserId,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function requireFolder(workspaceId: string, folderId: string): Promise<void> {
  const [folder] = await db
    .select({ id: folders.id })
    .from(folders)
    .where(and(eq(folders.id, folderId), eq(folders.workspaceId, workspaceId)))
    .limit(1);
  if (!folder) throw notFound("Folder tidak ditemukan.");
}

const listRoute = createRoute({
  method: "get",
  path: "/folders/{id}/contexts",
  tags: ["Creator contexts"],
  request: { params: folderParams },
  responses: {
    200: {
      description: "Pre-context entries of the folder",
      content: { "application/json": { schema: z.array(FolderContextSchema) } },
    },
    404: { description: "Folder not found", content: errorContent },
  },
});

creatorContextRoutes.openapi(listRoute, async (c) => {
  const auth = c.get("auth");
  const workspaceId = auth.workspaceId;
  if (!workspaceId) throw notFound("Workspace aktif tidak ditemukan.");
  const { id } = c.req.valid("param");
  await requireFolder(workspaceId, id);

  const rows = await db
    .select()
    .from(folderContexts)
    .where(eq(folderContexts.folderId, id))
    .orderBy(asc(folderContexts.createdAt));

  return c.json(rows.map(toContext), 200);
});

const createRoute_ = createRoute({
  method: "post",
  path: "/folders/{id}/contexts",
  tags: ["Creator contexts"],
  request: {
    params: folderParams,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            source: ContextSourceSchema.default("TEXT"),
            label: z.string().default(""),
            text: z.string().optional(),
            mediaAssetId: z.string().uuid().optional(),
            generationId: z.string().uuid().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: { description: "Context created", content: { "application/json": { schema: FolderContextSchema } } },
    400: { description: "Invalid source", content: errorContent },
    404: { description: "Folder not found", content: errorContent },
  },
});

creatorContextRoutes.openapi(createRoute_, async (c) => {
  const auth = c.get("auth");
  const workspaceId = auth.workspaceId;
  if (!workspaceId) throw notFound("Workspace aktif tidak ditemukan.");
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  await requireFolder(workspaceId, id);

  let text = (body.text ?? "").trim();
  let mediaAssetId: string | null = body.mediaAssetId ?? null;
  let generationId: string | null = body.generationId ?? null;

  if (body.source === "UPLOAD") {
    if (!mediaAssetId) throw validation("Pilih berkas untuk konteks ini.");
    text = (await analyzeAsset(workspaceId, { mediaAssetId })).text;
  } else if (body.source === "GENERATION") {
    if (!generationId) throw validation("Pilih hasil render untuk konteks ini.");
    const [generation] = await db
      .select({ id: generations.id })
      .from(generations)
      .where(and(eq(generations.id, generationId), eq(generations.workspaceId, workspaceId)))
      .limit(1);
    if (!generation) throw notFound("Generation tidak ditemukan.");
    text = (await analyzeAsset(workspaceId, { generationId })).text;
  } else {
    mediaAssetId = null;
    generationId = null;
    if (text.length === 0) throw validation("Teks konteks tidak boleh kosong.");
  }

  const label = body.label.trim();
  const [created] = await db
    .insert(folderContexts)
    .values({
      workspaceId,
      folderId: id,
      source: body.source,
      label: label.length > 0 ? label : body.source === "TEXT" ? "Catatan" : "Lampiran",
      text,
      mediaAssetId,
      generationId,
      createdByUserId: auth.user.id,
      isActive: true,
      updatedAt: new Date(),
    })
    .returning();
  if (!created) throw notFound("Konteks gagal dibuat.");

  return c.json(toContext(created), 201);
});

const patchRoute = createRoute({
  method: "patch",
  path: "/contexts/{contextId}",
  tags: ["Creator contexts"],
  request: {
    params: contextParams,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            label: z.string().optional(),
            text: z.string().optional(),
            isActive: z.boolean().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Context updated", content: { "application/json": { schema: FolderContextSchema } } },
    404: { description: "Context not found", content: errorContent },
  },
});

creatorContextRoutes.openapi(patchRoute, async (c) => {
  const auth = c.get("auth");
  const workspaceId = auth.workspaceId;
  if (!workspaceId) throw notFound("Workspace aktif tidak ditemukan.");
  const { contextId } = c.req.valid("param");
  const body = c.req.valid("json");

  const patch: { label?: string; text?: string; isActive?: boolean; updatedAt: Date } = {
    updatedAt: new Date(),
  };
  if (body.label !== undefined) patch.label = body.label.trim();
  if (body.text !== undefined) {
    const text = body.text.trim();
    if (text.length === 0) throw validation("Teks konteks tidak boleh kosong.");
    patch.text = text;
  }
  if (body.isActive !== undefined) patch.isActive = body.isActive;

  const [updated] = await db
    .update(folderContexts)
    .set(patch)
    .where(
      and(eq(folderContexts.id, contextId), eq(folderContexts.workspaceId, workspaceId)),
    )
    .returning();
  if (!updated) throw notFound("Konteks tidak ditemukan.");

  return c.json(toContext(updated), 200);
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/contexts/{contextId}",
  tags: ["Creator contexts"],
  request: { params: contextParams },
  responses: {
    204: { description: "Context deleted" },
    404: { description: "Context not found", content: errorContent },
  },
});

creatorContextRoutes.openapi(deleteRoute, async (c) => {
  const auth = c.get("auth");
  const workspaceId = auth.workspaceId;
  if (!workspaceId) throw notFound("Workspace aktif tidak ditemukan.");
  const { contextId } = c.req.valid("param");

  const [deleted] = await db
    .delete(folderContexts)
    .where(and(eq(folderContexts.id, contextId), eq(folderContexts.workspaceId, workspaceId)))
    .returning({ id: folderContexts.id });
  if (!deleted) throw notFound("Konteks tidak ditemukan.");

  return c.body(null, 204);
});

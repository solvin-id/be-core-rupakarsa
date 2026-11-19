import { and, desc, eq, sql } from "drizzle-orm";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { requireWorkspace, sessionGuard } from "../../auth/middleware.js";
import { db } from "../../db/client.js";
import { folders, generations } from "../../db/schema.js";
import { notFound, validation } from "../../http/errors.js";
import { defaultHook } from "../../http/route-helpers.js";
import { toFolder, toGeneration } from "../../http/serialize.js";
import {
  ErrorResponseSchema,
  FolderSchema,
  FolderWithStatsSchema,
  GenerationSchema,
} from "../../http/schemas.js";
import type { AppBindings } from "../../http/types.js";
import { purgedMapFor } from "../../services/generation-service.js";
import { getCharacterRow } from "../../services/higgsfield-character-service.js";
import { estimateOf, estimatesForModels, progressFor } from "../../services/progress-service.js";

export const creatorFolderRoutes = new OpenAPIHono<AppBindings>({ defaultHook });

const errorContent = { "application/json": { schema: ErrorResponseSchema } };
const folderParams = z.object({ id: z.string().uuid() });

creatorFolderRoutes.use("/folders", sessionGuard(), requireWorkspace("MEMBER"));
creatorFolderRoutes.use("/folders/*", sessionGuard(), requireWorkspace("MEMBER"));

const listRoute = createRoute({
  method: "get",
  path: "/folders",
  tags: ["Creator folders"],
  responses: {
    200: {
      description: "Folders of the active workspace",
      content: { "application/json": { schema: z.array(FolderWithStatsSchema) } },
    },
    403: { description: "No workspace membership", content: errorContent },
  },
});

creatorFolderRoutes.openapi(listRoute, async (c) => {
  const auth = c.get("auth");
  const workspaceId = auth.workspaceId;
  if (!workspaceId) throw notFound("Workspace aktif tidak ditemukan.");

  const rows = await db
    .select({
      folder: folders,
      videoCount: sql<number>`count(*) filter (where ${generations.mediaType} = 'VIDEO')`.mapWith(Number),
      imageCount: sql<number>`count(*) filter (where ${generations.mediaType} = 'IMAGE')`.mapWith(Number),
      tokensUsed: sql<number>`coalesce(sum(${generations.tokensCharged}), 0)`.mapWith(Number),
    })
    .from(folders)
    .leftJoin(generations, eq(generations.folderId, folders.id))
    .where(eq(folders.workspaceId, workspaceId))
    .groupBy(folders.id)
    .orderBy(desc(folders.updatedAt));

  return c.json(
    rows.map((row) => ({
      ...toFolder(row.folder),
      videoCount: row.videoCount,
      imageCount: row.imageCount,
      tokensUsed: row.tokensUsed,
    })),
    200,
  );
});

const createFolderRoute = createRoute({
  method: "post",
  path: "/folders",
  tags: ["Creator folders"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ name: z.string(), description: z.string().optional() }),
        },
      },
    },
  },
  responses: {
    201: { description: "Folder created", content: { "application/json": { schema: FolderSchema } } },
    400: { description: "Invalid name", content: errorContent },
  },
});

creatorFolderRoutes.openapi(createFolderRoute, async (c) => {
  const auth = c.get("auth");
  const workspaceId = auth.workspaceId;
  if (!workspaceId) throw notFound("Workspace aktif tidak ditemukan.");

  const body = c.req.valid("json");
  const name = body.name.trim();
  if (name.length < 2) throw validation("Nama folder minimal 2 karakter.");

  const [folder] = await db
    .insert(folders)
    .values({
      workspaceId,
      userId: auth.user.id,
      name,
      description: (body.description ?? "").trim(),
      updatedAt: new Date(),
    })
    .returning();
  if (!folder) throw notFound("Folder gagal dibuat.");

  return c.json(toFolder(folder), 201);
});

const patchFolderRoute = createRoute({
  method: "patch",
  path: "/folders/{id}",
  tags: ["Creator folders"],
  request: {
    params: folderParams,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().optional(),
            description: z.string().optional(),
            characterReferenceId: z.string().uuid().nullable().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Folder updated", content: { "application/json": { schema: FolderSchema } } },
    400: { description: "Invalid name", content: errorContent },
    404: { description: "Folder not found", content: errorContent },
  },
});

creatorFolderRoutes.openapi(patchFolderRoute, async (c) => {
  const auth = c.get("auth");
  const workspaceId = auth.workspaceId;
  if (!workspaceId) throw notFound("Workspace aktif tidak ditemukan.");

  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

  const patch: {
    name?: string;
    description?: string;
    characterReferenceId?: string | null;
    updatedAt: Date;
  } = { updatedAt: new Date() };
  if (body.name !== undefined) {
    const name = body.name.trim();
    if (name.length < 2) throw validation("Nama folder minimal 2 karakter.");
    patch.name = name;
  }
  if (body.description !== undefined) patch.description = body.description.trim();
  if (body.characterReferenceId !== undefined) {
    if (body.characterReferenceId === null) {
      patch.characterReferenceId = null;
    } else {
      const character = await getCharacterRow(body.characterReferenceId, workspaceId);
      if (character.status !== "COMPLETED" || !character.externalId) {
        throw validation("Karakter belum selesai dilatih.");
      }
      patch.characterReferenceId = character.id;
    }
  }

  const [folder] = await db
    .update(folders)
    .set(patch)
    .where(and(eq(folders.id, id), eq(folders.workspaceId, workspaceId)))
    .returning();
  if (!folder) throw notFound("Folder tidak ditemukan.");

  return c.json(toFolder(folder), 200);
});

const deleteFolderRoute = createRoute({
  method: "delete",
  path: "/folders/{id}",
  tags: ["Creator folders"],
  request: { params: folderParams },
  responses: {
    204: { description: "Folder deleted" },
    404: { description: "Folder not found", content: errorContent },
  },
});

creatorFolderRoutes.openapi(deleteFolderRoute, async (c) => {
  const auth = c.get("auth");
  const workspaceId = auth.workspaceId;
  if (!workspaceId) throw notFound("Workspace aktif tidak ditemukan.");

  const { id } = c.req.valid("param");
  const [deleted] = await db
    .delete(folders)
    .where(and(eq(folders.id, id), eq(folders.workspaceId, workspaceId)))
    .returning({ id: folders.id });
  if (!deleted) throw notFound("Folder tidak ditemukan.");

  return c.body(null, 204);
});

const folderGenerationsRoute = createRoute({
  method: "get",
  path: "/folders/{id}/generations",
  tags: ["Creator folders"],
  request: { params: folderParams },
  responses: {
    200: {
      description: "Generations of the folder",
      content: { "application/json": { schema: z.array(GenerationSchema) } },
    },
    404: { description: "Folder not found", content: errorContent },
  },
});

creatorFolderRoutes.openapi(folderGenerationsRoute, async (c) => {
  const auth = c.get("auth");
  const workspaceId = auth.workspaceId;
  if (!workspaceId) throw notFound("Workspace aktif tidak ditemukan.");

  const { id } = c.req.valid("param");
  const [folder] = await db
    .select({ id: folders.id })
    .from(folders)
    .where(and(eq(folders.id, id), eq(folders.workspaceId, workspaceId)))
    .limit(1);
  if (!folder) throw notFound("Folder tidak ditemukan.");

  const rows = await db
    .select()
    .from(generations)
    .where(eq(generations.folderId, folder.id))
    .orderBy(desc(generations.createdAt));

  const purged = await purgedMapFor(rows.map((row) => row.id));
  const estimates = await estimatesForModels(
    db,
    rows.map((row) => ({ id: row.modelId, mediaType: row.mediaType })),
  );
  return c.json(
    rows.map((row) =>
      toGeneration(row, purged.get(row.id) ?? null, progressFor(row, estimateOf(estimates, row))),
    ),
    200,
  );
});

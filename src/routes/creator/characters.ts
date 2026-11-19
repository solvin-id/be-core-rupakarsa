import { and, eq, inArray } from "drizzle-orm";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { requireWorkspace, roleAtLeast, sessionGuard } from "../../auth/middleware.js";
import { db } from "../../db/client.js";
import { aiProviders, mediaAssets } from "../../db/schema.js";
import type { AiCharacterReferenceRow } from "../../db/schema.js";
import { conflict, forbidden, notFound, validation } from "../../http/errors.js";
import { clientIp } from "../../http/middleware.js";
import { defaultHook } from "../../http/route-helpers.js";
import { AiCharacterReferenceSchema, ErrorResponseSchema } from "../../http/schemas.js";
import type { AppBindings } from "../../http/types.js";
import { logAudit } from "../../services/audit-service.js";
import {
  createCharacter,
  getCharacterRow,
  listCharacters,
  refreshCharacter,
} from "../../services/higgsfield-character-service.js";
import { resolveProviderKey } from "../../services/model-sync-service.js";
import { urlForAsset } from "../../services/storage-service.js";

export const creatorCharacterRoutes = new OpenAPIHono<AppBindings>({ defaultHook });

const errorContent = { "application/json": { schema: ErrorResponseSchema } };
const characterParams = z.object({ id: z.string().uuid() });

creatorCharacterRoutes.use("/characters", sessionGuard(), requireWorkspace("MEMBER"));
creatorCharacterRoutes.use("/characters/*", sessionGuard(), requireWorkspace("MEMBER"));

/**
 * `ai_character_references.status` is already the mapped enum, but the row type is `text`; the
 * serializer narrows it so the DTO schema can stay honest about the five provider states.
 */
function toCharacter(row: AiCharacterReferenceRow) {
  return AiCharacterReferenceSchema.parse({
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  });
}

async function higgsfieldProvider() {
  const [provider] = await db
    .select()
    .from(aiProviders)
    .where(eq(aiProviders.code, "HIGGSFIELD"))
    .limit(1);
  if (!provider) throw notFound("Provider Higgsfield tidak ditemukan.");
  if (resolveProviderKey(provider).length === 0) {
    throw conflict("API key Higgsfield belum disetel. Setel di kartu provider terlebih dahulu.");
  }
  return provider;
}

const listRoute = createRoute({
  method: "get",
  path: "/characters",
  tags: ["Creator characters"],
  responses: {
    200: {
      description: "Soul ID references of the active workspace, newest first",
      content: { "application/json": { schema: z.array(AiCharacterReferenceSchema) } },
    },
    403: { description: "No active workspace", content: errorContent },
  },
});

creatorCharacterRoutes.openapi(listRoute, async (c) => {
  const auth = c.get("auth");
  const workspaceId = auth.workspaceId;
  if (!workspaceId) throw notFound("Workspace aktif tidak ditemukan.");

  const rows = await listCharacters(workspaceId);
  return c.json(rows.map(toCharacter), 200);
});

const trainRoute = createRoute({
  method: "post",
  path: "/characters",
  tags: ["Creator characters"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1).max(100),
            modelVersion: z.enum(["v1", "v2", "cinema"]).default("v1"),
            imageAssetIds: z.array(z.string().uuid()).min(1).max(10),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Training queued",
      content: { "application/json": { schema: AiCharacterReferenceSchema } },
    },
    400: { description: "Invalid payload or asset", content: errorContent },
    403: { description: "Not a workspace admin", content: errorContent },
    404: { description: "Provider not found", content: errorContent },
    409: { description: "Provider key missing", content: errorContent },
  },
});

creatorCharacterRoutes.openapi(trainRoute, async (c) => {
  const auth = c.get("auth");
  const workspaceId = auth.workspaceId;
  if (!workspaceId) throw notFound("Workspace aktif tidak ditemukan.");
  if (!roleAtLeast(c.get("membership").role, "ADMIN")) {
    throw forbidden("Hanya admin workspace yang dapat melatih Soul ID.");
  }

  const body = c.req.valid("json");
  const assets = await db
    .select()
    .from(mediaAssets)
    .where(and(eq(mediaAssets.workspaceId, workspaceId), inArray(mediaAssets.id, body.imageAssetIds)));
  if (assets.length !== body.imageAssetIds.length) {
    throw validation("Gambar latihan tidak ditemukan.");
  }

  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const ordered = body.imageAssetIds.map((id) => byId.get(id));
  if (ordered.some((asset) => !asset || !asset.mime.startsWith("image/"))) {
    throw validation("Gambar latihan harus berupa gambar.");
  }

  const provider = await higgsfieldProvider();
  const imageUrls = await Promise.all(ordered.map((asset) => urlForAsset(asset!)));
  const row = await createCharacter({
    provider,
    workspaceId,
    name: body.name,
    modelVersion: body.modelVersion,
    imageUrls,
    actorUserId: auth.user.id,
  });

  await logAudit(db, {
    actorUserId: auth.user.id,
    action: "character.create",
    targetType: "ai_character_reference",
    targetId: row.id,
    metadata: { name: row.name, modelVersion: row.modelVersion, images: imageUrls.length },
    ip: clientIp(c),
  });

  return c.json(toCharacter(row), 201);
});

const refreshRoute = createRoute({
  method: "post",
  path: "/characters/{id}/refresh",
  tags: ["Creator characters"],
  request: { params: characterParams },
  responses: {
    200: {
      description: "Reference state after the provider poll",
      content: { "application/json": { schema: AiCharacterReferenceSchema } },
    },
    403: { description: "Not a workspace admin", content: errorContent },
    404: { description: "Reference not found", content: errorContent },
    429: { description: "Provider rate limit", content: errorContent },
  },
});

creatorCharacterRoutes.openapi(refreshRoute, async (c) => {
  const auth = c.get("auth");
  const workspaceId = auth.workspaceId;
  if (!workspaceId) throw notFound("Workspace aktif tidak ditemukan.");
  if (!roleAtLeast(c.get("membership").role, "ADMIN")) {
    throw forbidden("Hanya admin workspace yang dapat melatih Soul ID.");
  }

  const { id } = c.req.valid("param");
  await getCharacterRow(id, workspaceId);
  const row = await refreshCharacter(id);
  return c.json(toCharacter(row), 200);
});

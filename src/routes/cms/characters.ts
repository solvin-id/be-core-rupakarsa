import { eq } from "drizzle-orm";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { requireCms, sessionGuard } from "../../auth/middleware.js";
import { db } from "../../db/client.js";
import { aiProviders } from "../../db/schema.js";
import type { AiCharacterReferenceRow } from "../../db/schema.js";
import { conflict, notFound } from "../../http/errors.js";
import { clientIp } from "../../http/middleware.js";
import { defaultHook } from "../../http/route-helpers.js";
import { AiCharacterReferenceSchema, ErrorResponseSchema } from "../../http/schemas.js";
import type { AppBindings } from "../../http/types.js";
import { logAudit } from "../../services/audit-service.js";
import {
  createCharacter,
  listCharacters,
  refreshCharacter,
} from "../../services/higgsfield-character-service.js";
import { resolveProviderKey } from "../../services/model-sync-service.js";

export const cmsCharacterRoutes = new OpenAPIHono<AppBindings>({ defaultHook });

const errorContent = { "application/json": { schema: ErrorResponseSchema } };
const characterParams = z.object({ id: z.string().uuid() });

cmsCharacterRoutes.use("/higgsfield/characters", sessionGuard(), requireCms());
cmsCharacterRoutes.use("/higgsfield/characters/*", sessionGuard(), requireCms());

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
  path: "/higgsfield/characters",
  tags: ["CMS Higgsfield"],
  responses: {
    200: {
      description: "Soul ID references, newest first",
      content: { "application/json": { schema: z.array(AiCharacterReferenceSchema) } },
    },
  },
});

cmsCharacterRoutes.openapi(listRoute, async (c) => {
  const rows = await listCharacters();
  return c.json(rows.map(toCharacter), 200);
});

const createRoute_ = createRoute({
  method: "post",
  path: "/higgsfield/characters",
  tags: ["CMS Higgsfield"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1).max(100),
            modelVersion: z.enum(["v1", "v2", "cinema"]).default("v1"),
            imageUrls: z.array(z.string().url()).min(1).max(100),
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
    400: { description: "Invalid payload", content: errorContent },
    409: { description: "Provider key missing", content: errorContent },
    429: { description: "Provider rate limit", content: errorContent },
  },
});

cmsCharacterRoutes.openapi(createRoute_, async (c) => {
  const auth = c.get("auth");
  const body = c.req.valid("json");
  const provider = await higgsfieldProvider();

  const row = await createCharacter({
    provider,
    name: body.name,
    modelVersion: body.modelVersion,
    imageUrls: body.imageUrls,
    actorUserId: auth.user.id,
  });

  await logAudit(db, {
    actorUserId: auth.user.id,
    action: "character.create",
    targetType: "ai_character_reference",
    targetId: row.id,
    metadata: { name: row.name, modelVersion: row.modelVersion, images: body.imageUrls.length },
    ip: clientIp(c),
  });

  return c.json(toCharacter(row), 201);
});

const refreshRoute = createRoute({
  method: "post",
  path: "/higgsfield/characters/{id}/refresh",
  tags: ["CMS Higgsfield"],
  request: { params: characterParams },
  responses: {
    200: {
      description: "Reference state after the provider poll",
      content: { "application/json": { schema: AiCharacterReferenceSchema } },
    },
    404: { description: "Reference not found", content: errorContent },
    429: { description: "Provider rate limit", content: errorContent },
  },
});

cmsCharacterRoutes.openapi(refreshRoute, async (c) => {
  const auth = c.get("auth");
  const { id } = c.req.valid("param");
  const row = await refreshCharacter(id);

  await logAudit(db, {
    actorUserId: auth.user.id,
    action: "character.refresh",
    targetType: "ai_character_reference",
    targetId: row.id,
    metadata: { status: row.status, externalId: row.externalId },
    ip: clientIp(c),
  });

  return c.json(toCharacter(row), 200);
});

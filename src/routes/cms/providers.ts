import { eq, inArray } from "drizzle-orm";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { requireCms, sessionGuard } from "../../auth/middleware.js";
import { encryptSecret, maskSecret } from "../../crypto/encryption.js";
import { db } from "../../db/client.js";
import { aiModels, aiProviders, generations } from "../../db/schema.js";
import { conflict, notFound, validation } from "../../http/errors.js";
import { clientIp } from "../../http/middleware.js";
import { defaultHook } from "../../http/route-helpers.js";
import { toModel, toProvider } from "../../http/serialize.js";
import {
  AiProviderSchema,
  ErrorResponseSchema,
  ProviderTestSchema,
  RemoteModelSchema,
  SyncResultSchema,
} from "../../http/schemas.js";
import type { AppBindings } from "../../http/types.js";
import { logAudit } from "../../services/audit-service.js";
import { fetchRemoteCatalog, syncProviderModels } from "../../services/model-sync-service.js";

export const cmsProviderRoutes = new OpenAPIHono<AppBindings>({ defaultHook });

const errorContent = { "application/json": { schema: ErrorResponseSchema } };
const providerParams = z.object({ id: z.string().uuid() });

const HIGGSFIELD_KEY_PATTERN = /^[^:]+:[^:]+$/;

cmsProviderRoutes.use("/providers", sessionGuard(), requireCms());
cmsProviderRoutes.use("/providers/*", sessionGuard(), requireCms());

function assertHiggsfieldKey(apiKey: string): void {
  if (!HIGGSFIELD_KEY_PATTERN.test(apiKey)) {
    throw validation("Format API key Higgsfield: key_id:key_secret.");
  }
}

const listRoute = createRoute({
  method: "get",
  path: "/providers",
  tags: ["CMS providers"],
  responses: {
    200: {
      description: "Providers with masked keys",
      content: { "application/json": { schema: z.array(AiProviderSchema) } },
    },
  },
});

cmsProviderRoutes.openapi(listRoute, async (c) => {
  const rows = await db.select().from(aiProviders).orderBy(aiProviders.name);
  return c.json(rows.map(toProvider), 200);
});

const createProviderRoute = createRoute({
  method: "post",
  path: "/providers",
  tags: ["CMS providers"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string(),
            code: z.string(),
            baseUrl: z.string(),
            apiKey: z.string(),
            modelsPath: z.string().default("/models"),
            supportsVideoInput: z.boolean().default(false),
            isActive: z.boolean().default(true),
          }),
        },
      },
    },
  },
  responses: {
    201: { description: "Provider created", content: { "application/json": { schema: AiProviderSchema } } },
    400: { description: "Invalid API key", content: errorContent },
    409: { description: "Code already used", content: errorContent },
  },
});

cmsProviderRoutes.openapi(createProviderRoute, async (c) => {
  const auth = c.get("auth");
  const body = c.req.valid("json");
  const code = body.code.trim().toUpperCase();
  const name = body.name.trim();
  if (name.length < 2) throw validation("Nama provider minimal 2 karakter.");
  const apiKey = body.apiKey.trim();
  if (apiKey.length < 6) throw validation("API key minimal 6 karakter.");
  if (code === "HIGGSFIELD") throw validation("Provider Higgsfield dikelola sistem.");

  const [existing] = await db.select({ id: aiProviders.id }).from(aiProviders).where(eq(aiProviders.code, code)).limit(1);
  if (existing) throw conflict("Kode provider sudah dipakai.");

  const [created] = await db
    .insert(aiProviders)
    .values({
      code,
      name,
      baseUrl: body.baseUrl.trim(),
      apiKeyEncrypted: encryptSecret(apiKey),
      apiKeyMasked: maskSecret(apiKey),
      kind: "OPENAI_COMPATIBLE",
      isFixed: false,
      modelsPath: body.modelsPath.trim() || "/models",
      supportsVideoInput: body.supportsVideoInput,
      isActive: body.isActive,
    })
    .returning();
  if (!created) throw conflict("Provider gagal dibuat.");

  await logAudit(db, {
    actorUserId: auth.user.id,
    action: "provider.create",
    targetType: "ai_provider",
    targetId: created.id,
    metadata: { code, kind: created.kind },
    ip: clientIp(c),
  });

  return c.json(toProvider(created), 201);
});

const patchProviderRoute = createRoute({
  method: "patch",
  path: "/providers/{id}",
  tags: ["CMS providers"],
  request: {
    params: providerParams,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().optional(),
            baseUrl: z.string().optional(),
            apiKey: z.string().optional(),
            modelsPath: z.string().optional(),
            supportsVideoInput: z.boolean().optional(),
            isActive: z.boolean().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Provider updated", content: { "application/json": { schema: AiProviderSchema } } },
    400: { description: "Invalid API key", content: errorContent },
    404: { description: "Provider not found", content: errorContent },
  },
});

cmsProviderRoutes.openapi(patchProviderRoute, async (c) => {
  const auth = c.get("auth");
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

  const [provider] = await db.select().from(aiProviders).where(eq(aiProviders.id, id)).limit(1);
  if (!provider) throw notFound("Provider tidak ditemukan.");

  const patch: {
    name?: string;
    baseUrl?: string;
    apiKeyEncrypted?: string;
    apiKeyMasked?: string;
    modelsPath?: string;
    supportsVideoInput?: boolean;
    isActive?: boolean;
    updatedAt: Date;
  } = { updatedAt: new Date() };

  if (body.name !== undefined) {
    const name = body.name.trim();
    if (name.length < 2) throw validation("Nama provider minimal 2 karakter.");
    patch.name = name;
  }
  if (body.baseUrl !== undefined) patch.baseUrl = body.baseUrl.trim();
  if (body.modelsPath !== undefined) patch.modelsPath = body.modelsPath.trim() || "/models";
  if (body.supportsVideoInput !== undefined) patch.supportsVideoInput = body.supportsVideoInput;
  if (body.isActive !== undefined) patch.isActive = body.isActive;
  if (body.apiKey !== undefined && body.apiKey.trim().length > 0) {
    const apiKey = body.apiKey.trim();
    if (provider.isFixed || provider.kind === "HIGGSFIELD") assertHiggsfieldKey(apiKey);
    else if (apiKey.length < 6) throw validation("API key minimal 6 karakter.");
    patch.apiKeyEncrypted = encryptSecret(apiKey);
    patch.apiKeyMasked = maskSecret(apiKey);
  }

  const [updated] = await db
    .update(aiProviders)
    .set(patch)
    .where(eq(aiProviders.id, id))
    .returning();
  if (!updated) throw notFound("Provider tidak ditemukan.");

  await logAudit(db, {
    actorUserId: auth.user.id,
    action: "provider.update",
    targetType: "ai_provider",
    targetId: updated.id,
    metadata: { fields: Object.keys(patch).filter((key) => key !== "updatedAt") },
    ip: clientIp(c),
  });

  return c.json(toProvider(updated), 200);
});

const deleteProviderRoute = createRoute({
  method: "delete",
  path: "/providers/{id}",
  tags: ["CMS providers"],
  request: { params: providerParams },
  responses: {
    204: { description: "Provider deleted" },
    404: { description: "Provider not found", content: errorContent },
    409: { description: "Fixed provider or render history", content: errorContent },
  },
});

cmsProviderRoutes.openapi(deleteProviderRoute, async (c) => {
  const auth = c.get("auth");
  const { id } = c.req.valid("param");

  const [provider] = await db.select().from(aiProviders).where(eq(aiProviders.id, id)).limit(1);
  if (!provider) throw notFound("Provider tidak ditemukan.");
  if (provider.isFixed) throw conflict("Provider tetap tidak dapat dihapus.");

  const modelRows = await db.select({ id: aiModels.id }).from(aiModels).where(eq(aiModels.providerId, id));
  if (modelRows.length > 0) {
    const used = await db
      .select({ id: generations.id })
      .from(generations)
      .where(
        inArray(
          generations.modelId,
          modelRows.map((row) => row.id),
        ),
      )
      .limit(1);
    if (used.length > 0) throw conflict("Provider masih dipakai model yang punya riwayat render.");
  }

  await db.transaction(async (tx) => {
    await tx.delete(aiModels).where(eq(aiModels.providerId, id));
    await tx.delete(aiProviders).where(eq(aiProviders.id, id));
  });

  await logAudit(db, {
    actorUserId: auth.user.id,
    action: "provider.delete",
    targetType: "ai_provider",
    targetId: id,
    metadata: { code: provider.code },
    ip: clientIp(c),
  });

  return c.body(null, 204);
});

const testProviderRoute = createRoute({
  method: "post",
  path: "/providers/{id}/test",
  tags: ["CMS providers"],
  request: { params: providerParams },
  responses: {
    200: { description: "Connection test", content: { "application/json": { schema: ProviderTestSchema } } },
    404: { description: "Provider not found", content: errorContent },
  },
});

cmsProviderRoutes.openapi(testProviderRoute, async (c) => {
  const { id } = c.req.valid("param");
  const [provider] = await db.select().from(aiProviders).where(eq(aiProviders.id, id)).limit(1);
  if (!provider) throw notFound("Provider tidak ditemukan.");

  try {
    const catalog = await fetchRemoteCatalog(provider);
    return c.json(
      {
        ok: true,
        message: `Koneksi ${provider.name} berhasil, ${catalog.models.length} model terdeteksi.`,
      },
      200,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Tidak dapat menghubungi provider.";
    return c.json({ ok: false, message }, 200);
  }
});

const remoteModelsRoute = createRoute({
  method: "get",
  path: "/providers/{id}/remote-models",
  tags: ["CMS providers"],
  request: { params: providerParams },
  responses: {
    200: {
      description: "Catalog preview without writing",
      content: { "application/json": { schema: z.object({ models: z.array(RemoteModelSchema) }) } },
    },
    404: { description: "Provider not found", content: errorContent },
    502: { description: "Provider unreachable", content: errorContent },
  },
});

cmsProviderRoutes.openapi(remoteModelsRoute, async (c) => {
  const { id } = c.req.valid("param");
  const [provider] = await db.select().from(aiProviders).where(eq(aiProviders.id, id)).limit(1);
  if (!provider) throw notFound("Provider tidak ditemukan.");
  const catalog = await fetchRemoteCatalog(provider);
  return c.json({ models: catalog.models }, 200);
});

const syncModelsRoute = createRoute({
  method: "post",
  path: "/providers/{id}/sync-models",
  tags: ["CMS providers"],
  request: { params: providerParams },
  responses: {
    200: { description: "Catalog synced", content: { "application/json": { schema: SyncResultSchema } } },
    404: { description: "Provider not found", content: errorContent },
    502: { description: "Provider unreachable", content: errorContent },
  },
});

cmsProviderRoutes.openapi(syncModelsRoute, async (c) => {
  const auth = c.get("auth");
  const { id } = c.req.valid("param");
  const result = await syncProviderModels(db, id);

  await logAudit(db, {
    actorUserId: auth.user.id,
    action: "provider.sync",
    targetType: "ai_provider",
    targetId: id,
    metadata: { added: result.added, updated: result.updated, skipped: result.skipped },
    ip: clientIp(c),
  });

  return c.json({ ...result, models: result.models.map((row) => toModel(row)) }, 200);
});

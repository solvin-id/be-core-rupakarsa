import { eq } from "drizzle-orm";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { requireCms, sessionGuard } from "../../auth/middleware.js";
import { encryptSecret, maskSecret } from "../../crypto/encryption.js";
import { db } from "../../db/client.js";
import { aiProviders } from "../../db/schema.js";
import { conflict, notFound, validation } from "../../http/errors.js";
import { defaultHook } from "../../http/route-helpers.js";
import { toProvider } from "../../http/serialize.js";
import {
  AiProviderSchema,
  ErrorResponseSchema,
  ProviderTestSchema,
} from "../../http/schemas.js";
import type { AppBindings } from "../../http/types.js";
import { env } from "../../env.js";

export const cmsProviderRoutes = new OpenAPIHono<AppBindings>({ defaultHook });

const errorContent = { "application/json": { schema: ErrorResponseSchema } };
const providerParams = z.object({ id: z.string().uuid() });

cmsProviderRoutes.use("/providers", sessionGuard(), requireCms());
cmsProviderRoutes.use("/providers/*", sessionGuard(), requireCms());

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
  const body = c.req.valid("json");
  const code = body.code.trim().toUpperCase();
  const name = body.name.trim();
  if (name.length < 2) throw validation("Nama provider minimal 2 karakter.");
  const apiKey = body.apiKey.trim();
  if (apiKey.length < 6) throw validation("API key minimal 6 karakter.");

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
      isActive: body.isActive,
    })
    .returning();
  if (!created) throw conflict("Provider gagal dibuat.");

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
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

  const [provider] = await db.select().from(aiProviders).where(eq(aiProviders.id, id)).limit(1);
  if (!provider) throw notFound("Provider tidak ditemukan.");

  const patch: {
    name?: string;
    baseUrl?: string;
    apiKeyEncrypted?: string;
    apiKeyMasked?: string;
    isActive?: boolean;
    updatedAt: Date;
  } = { updatedAt: new Date() };

  if (body.name !== undefined) {
    const name = body.name.trim();
    if (name.length < 2) throw validation("Nama provider minimal 2 karakter.");
    patch.name = name;
  }
  if (body.baseUrl !== undefined) patch.baseUrl = body.baseUrl.trim();
  if (body.isActive !== undefined) patch.isActive = body.isActive;
  if (body.apiKey !== undefined && body.apiKey.trim().length > 0) {
    const apiKey = body.apiKey.trim();
    if (apiKey.length < 6) throw validation("API key minimal 6 karakter.");
    patch.apiKeyEncrypted = encryptSecret(apiKey);
    patch.apiKeyMasked = maskSecret(apiKey);
  }

  const [updated] = await db
    .update(aiProviders)
    .set(patch)
    .where(eq(aiProviders.id, id))
    .returning();
  if (!updated) throw notFound("Provider tidak ditemukan.");

  return c.json(toProvider(updated), 200);
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

  if (env.PROVIDER_MODE === "stub") {
    return c.json({ ok: true, message: `Koneksi ${provider.name} berhasil (mode simulasi).` }, 200);
  }

  try {
    const response = await fetch(provider.baseUrl, {
      method: "HEAD",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return c.json({ ok: false, message: `Provider membalas ${response.status}.` }, 200);
    }
    return c.json({ ok: true, message: `Koneksi ${provider.name} berhasil.` }, 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Tidak dapat menghubungi provider.";
    return c.json({ ok: false, message }, 200);
  }
});


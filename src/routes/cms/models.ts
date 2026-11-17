import { and, eq, ilike, or, sql } from "drizzle-orm";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { requireCms, sessionGuard } from "../../auth/middleware.js";
import { db } from "../../db/client.js";
import { aiModels, aiProviders } from "../../db/schema.js";
import type { ModelCapability } from "../../db/schema.js";
import { conflict, notFound, validation } from "../../http/errors.js";
import { clientIp } from "../../http/middleware.js";
import { defaultHook } from "../../http/route-helpers.js";
import { toModel } from "../../http/serialize.js";
import {
  AiModelSchema,
  ErrorResponseSchema,
  MediaCapabilitySchema,
  ModelAllowedParamsSchema,
  ModelMediaTypeSchema,
  ModelTemplateSchema,
} from "../../http/schemas.js";
import type { ModelMediaType } from "../../http/schemas.js";
import type { AppBindings } from "../../http/types.js";
import { logAudit } from "../../services/audit-service.js";

export const cmsModelRoutes = new OpenAPIHono<AppBindings>({ defaultHook });

const errorContent = { "application/json": { schema: ErrorResponseSchema } };
const modelParams = z.object({ id: z.string().uuid() });

cmsModelRoutes.use("/models", sessionGuard(), requireCms());
cmsModelRoutes.use("/models/*", sessionGuard(), requireCms());
cmsModelRoutes.use("/model-templates", sessionGuard(), requireCms());

function assertAllowedParams(
  value: { resolutions: string[]; aspectRatios: string[] },
  mediaType?: ModelMediaType,
): void {
  // Plan/analysis models carry no render options; an empty pair is their normal shape.
  if (mediaType === "TEXT") return;
  if (value.resolutions.length === 0 || value.aspectRatios.length === 0) {
    throw validation("Resolusi dan rasio aspek tidak boleh kosong.");
  }
}

function assertCapabilities(value: ModelCapability[]): void {
  if (value.length === 0) throw validation("Kapabilitas output wajib diisi.");
}

const listRoute = createRoute({
  method: "get",
  path: "/models",
  tags: ["CMS models"],
  request: {
    query: z.object({
      providerId: z.string().uuid().optional(),
      input: MediaCapabilitySchema.optional(),
      output: MediaCapabilitySchema.optional(),
      q: z.string().optional(),
      active: z.enum(["true", "false"]).optional(),
    }),
  },
  responses: {
    200: {
      description: "All models",
      content: { "application/json": { schema: z.array(AiModelSchema) } },
    },
  },
});

cmsModelRoutes.openapi(listRoute, async (c) => {
  const query = c.req.valid("query");
  const conditions = [];

  if (query.providerId) conditions.push(eq(aiModels.providerId, query.providerId));
  if (query.input) {
    conditions.push(sql`${aiModels.inputCapabilities} @> ARRAY[${query.input}]::model_capability[]`);
  }
  if (query.output) {
    conditions.push(sql`${aiModels.outputCapabilities} @> ARRAY[${query.output}]::model_capability[]`);
  }
  if (query.active) conditions.push(eq(aiModels.isActive, query.active === "true"));
  if (query.q && query.q.trim().length > 0) {
    const needle = `%${query.q.trim()}%`;
    const match = or(ilike(aiModels.displayName, needle), ilike(aiModels.code, needle));
    if (match) conditions.push(match);
  }

  const rows = await db
    .select()
    .from(aiModels)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(aiModels.displayName);

  return c.json(rows.map((row) => toModel(row)), 200);
});

const templatesRoute = createRoute({
  method: "get",
  path: "/model-templates",
  tags: ["CMS models"],
  request: {
    query: z.object({ providerCode: z.string().optional(), providerId: z.string().uuid().optional() }),
  },
  responses: {
    200: {
      description: "Model catalog of a provider, read from the synced rows",
      content: { "application/json": { schema: z.array(ModelTemplateSchema) } },
    },
  },
});

cmsModelRoutes.openapi(templatesRoute, async (c) => {
  const { providerCode, providerId } = c.req.valid("query");

  const providerRows = await db.select().from(aiProviders);
  const byCode = new Map(providerRows.map((row) => [row.code, row]));
  const byId = new Map(providerRows.map((row) => [row.id, row]));

  const provider = providerId
    ? byId.get(providerId)
    : providerCode
      ? byCode.get(providerCode.trim().toUpperCase())
      : null;

  if (providerId && !provider) throw notFound("Provider tidak ditemukan.");

  const rows = await db
    .select()
    .from(aiModels)
    .where(provider ? eq(aiModels.providerId, provider.id) : undefined)
    .orderBy(aiModels.displayName);

  return c.json(
    rows.map((row) => ({
      providerCode: byId.get(row.providerId)?.code ?? "",
      code: row.code,
      displayName: row.displayName,
      mediaType: row.mediaType,
      allowedParams: row.allowedParams,
      tokenCost: row.tokenCost,
    })),
    200,
  );
});

const createModelRoute = createRoute({
  method: "post",
  path: "/models",
  tags: ["CMS models"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            providerId: z.string().uuid(),
            code: z.string(),
            displayName: z.string(),
            providerModelId: z.string().optional(),
            mediaType: ModelMediaTypeSchema,
            inputCapabilities: z.array(MediaCapabilitySchema).optional(),
            outputCapabilities: z.array(MediaCapabilitySchema).optional(),
            allowedParams: ModelAllowedParamsSchema,
            tokenCost: z.number().int(),
            maxPromptChars: z.number().int().min(0).max(32000).nullable().optional(),
            isActive: z.boolean().default(true),
          }),
        },
      },
    },
  },
  responses: {
    201: { description: "Model created", content: { "application/json": { schema: AiModelSchema } } },
    400: { description: "Invalid params", content: errorContent },
    404: { description: "Provider not found", content: errorContent },
    409: { description: "Duplicate code for provider", content: errorContent },
  },
});

cmsModelRoutes.openapi(createModelRoute, async (c) => {
  const auth = c.get("auth");
  const body = c.req.valid("json");
  const code = body.code.trim().toLowerCase();
  const displayName = body.displayName.trim();
  if (code.length === 0) throw validation("Kode model wajib diisi.");
  if (displayName.length < 2) throw validation("Nama model minimal 2 karakter.");
  if (body.tokenCost < 0) throw validation("Tarif token harus angka 0 atau lebih.");
  assertAllowedParams(body.allowedParams, body.mediaType);

  const outputCapabilities = body.outputCapabilities ?? [body.mediaType];
  assertCapabilities(outputCapabilities);

  const [provider] = await db
    .select({ id: aiProviders.id })
    .from(aiProviders)
    .where(eq(aiProviders.id, body.providerId))
    .limit(1);
  if (!provider) throw notFound("Provider tidak ditemukan.");

  const [existing] = await db
    .select({ id: aiModels.id })
    .from(aiModels)
    .where(and(eq(aiModels.providerId, provider.id), eq(aiModels.code, code)))
    .limit(1);
  if (existing) throw conflict("Kode model sudah dipakai untuk provider ini.");

  const [created] = await db
    .insert(aiModels)
    .values({
      providerId: provider.id,
      code,
      displayName,
      providerModelId: body.providerModelId?.trim() || code,
      mediaType: body.mediaType,
      inputCapabilities: body.inputCapabilities ?? ["TEXT"],
      outputCapabilities,
      source: "MANUAL",
      allowedParams: body.allowedParams,
      tokenCost: body.tokenCost,
      maxPromptChars: body.maxPromptChars ?? null,
      isActive: body.isActive,
    })
    .returning();
  if (!created) throw conflict("Model gagal dibuat.");

  await logAudit(db, {
    actorUserId: auth.user.id,
    action: "model.create",
    targetType: "ai_model",
    targetId: created.id,
    metadata: { code, providerId: provider.id },
    ip: clientIp(c),
  });

  return c.json(toModel(created), 201);
});

const patchModelRoute = createRoute({
  method: "patch",
  path: "/models/{id}",
  tags: ["CMS models"],
  request: {
    params: modelParams,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            displayName: z.string().optional(),
            providerModelId: z.string().optional(),
            inputCapabilities: z.array(MediaCapabilitySchema).optional(),
            outputCapabilities: z.array(MediaCapabilitySchema).optional(),
            source: z.string().optional(),
            tokenCost: z.number().int().optional(),
            maxPromptChars: z.number().int().min(0).max(32000).nullable().optional(),
            allowedParams: ModelAllowedParamsSchema.optional(),
            isActive: z.boolean().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Model updated", content: { "application/json": { schema: AiModelSchema } } },
    400: { description: "Invalid params", content: errorContent },
    404: { description: "Model not found", content: errorContent },
  },
});

cmsModelRoutes.openapi(patchModelRoute, async (c) => {
  const auth = c.get("auth");
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

  if (body.tokenCost !== undefined && body.tokenCost < 0) {
    throw validation("Tarif token harus angka 0 atau lebih.");
  }
  const [existing] = await db.select().from(aiModels).where(eq(aiModels.id, id)).limit(1);
  if (!existing) throw notFound("Model tidak ditemukan.");

  if (body.allowedParams) assertAllowedParams(body.allowedParams, existing.mediaType);
  if (body.outputCapabilities !== undefined) assertCapabilities(body.outputCapabilities);

  if (body.source !== undefined && existing.source === "SYNC") {
    throw validation("Sumber model hasil sinkronisasi tidak dapat diubah.");
  }

  const patch: {
    displayName?: string;
    providerModelId?: string;
    inputCapabilities?: ModelCapability[];
    outputCapabilities?: ModelCapability[];
    source?: string;
    tokenCost?: number;
    maxPromptChars?: number | null;
    allowedParams?: { durations?: number[]; resolutions: string[]; aspectRatios: string[] };
    isActive?: boolean;
  } = {};

  if (body.displayName !== undefined) {
    const displayName = body.displayName.trim();
    if (displayName.length < 2) throw validation("Nama model minimal 2 karakter.");
    patch.displayName = displayName;
  }
  if (body.providerModelId !== undefined) patch.providerModelId = body.providerModelId.trim();
  if (body.inputCapabilities !== undefined) patch.inputCapabilities = body.inputCapabilities;
  if (body.outputCapabilities !== undefined) patch.outputCapabilities = body.outputCapabilities;
  if (body.source !== undefined) patch.source = body.source.trim().toUpperCase();
  if (body.tokenCost !== undefined) patch.tokenCost = body.tokenCost;
  if (body.maxPromptChars !== undefined) patch.maxPromptChars = body.maxPromptChars;
  if (body.allowedParams !== undefined) patch.allowedParams = body.allowedParams;
  if (body.isActive !== undefined) patch.isActive = body.isActive;

  const [updated] = await db.update(aiModels).set(patch).where(eq(aiModels.id, id)).returning();
  if (!updated) throw notFound("Model tidak ditemukan.");

  await logAudit(db, {
    actorUserId: auth.user.id,
    action: "model.update",
    targetType: "ai_model",
    targetId: updated.id,
    metadata: { fields: Object.keys(patch) },
    ip: clientIp(c),
  });

  return c.json(toModel(updated), 200);
});

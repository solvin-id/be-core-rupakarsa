import { and, eq } from "drizzle-orm";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { requireCms, sessionGuard } from "../../auth/middleware.js";
import { db } from "../../db/client.js";
import { aiModels, aiProviders } from "../../db/schema.js";
import { conflict, notFound, validation } from "../../http/errors.js";
import { defaultHook } from "../../http/route-helpers.js";
import { toModel } from "../../http/serialize.js";
import {
  AiModelSchema,
  ErrorResponseSchema,
  MediaTypeSchema,
  ModelAllowedParamsSchema,
  ModelTemplateSchema,
} from "../../http/schemas.js";
import type { AppBindings } from "../../http/types.js";
import { MODEL_TEMPLATES, templatesForProvider } from "../../services/model-catalog.js";

export const cmsModelRoutes = new OpenAPIHono<AppBindings>({ defaultHook });

const errorContent = { "application/json": { schema: ErrorResponseSchema } };
const modelParams = z.object({ id: z.string().uuid() });

cmsModelRoutes.use("/models", sessionGuard(), requireCms());
cmsModelRoutes.use("/models/*", sessionGuard(), requireCms());
cmsModelRoutes.use("/model-templates", sessionGuard(), requireCms());

function assertAllowedParams(value: { resolutions: string[]; aspectRatios: string[] }): void {
  if (value.resolutions.length === 0 || value.aspectRatios.length === 0) {
    throw validation("Resolusi dan rasio aspek tidak boleh kosong.");
  }
}

const listRoute = createRoute({
  method: "get",
  path: "/models",
  tags: ["CMS models"],
  responses: {
    200: {
      description: "All models",
      content: { "application/json": { schema: z.array(AiModelSchema) } },
    },
  },
});

cmsModelRoutes.openapi(listRoute, async (c) => {
  const rows = await db.select().from(aiModels).orderBy(aiModels.displayName);
  return c.json(rows.map(toModel), 200);
});

const templatesRoute = createRoute({
  method: "get",
  path: "/model-templates",
  tags: ["CMS models"],
  request: {
    query: z.object({ providerCode: z.string().optional() }),
  },
  responses: {
    200: {
      description: "Model templates from the catalog",
      content: { "application/json": { schema: z.array(ModelTemplateSchema) } },
    },
  },
});

cmsModelRoutes.openapi(templatesRoute, async (c) => {
  const { providerCode } = c.req.valid("query");
  const templates = providerCode ? templatesForProvider(providerCode.toUpperCase()) : MODEL_TEMPLATES;
  return c.json(
    templates.map((template) => ({
      providerCode: template.providerCode,
      code: template.code,
      displayName: template.displayName,
      mediaType: template.mediaType,
      allowedParams: template.allowedParams,
      tokenCost: template.tokenCost,
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
            mediaType: MediaTypeSchema,
            allowedParams: ModelAllowedParamsSchema,
            tokenCost: z.number().int(),
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
  const body = c.req.valid("json");
  const code = body.code.trim().toLowerCase();
  const displayName = body.displayName.trim();
  if (code.length === 0) throw validation("Kode model wajib diisi.");
  if (displayName.length < 2) throw validation("Nama model minimal 2 karakter.");
  if (body.tokenCost < 0) throw validation("Tarif token harus angka 0 atau lebih.");
  assertAllowedParams(body.allowedParams);

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
      mediaType: body.mediaType,
      allowedParams: body.allowedParams,
      tokenCost: body.tokenCost,
      isActive: body.isActive,
    })
    .returning();
  if (!created) throw conflict("Model gagal dibuat.");

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
            tokenCost: z.number().int().optional(),
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
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

  if (body.tokenCost !== undefined && body.tokenCost < 0) {
    throw validation("Tarif token harus angka 0 atau lebih.");
  }
  if (body.allowedParams) assertAllowedParams(body.allowedParams);

  const patch: {
    tokenCost?: number;
    allowedParams?: { durations?: number[]; resolutions: string[]; aspectRatios: string[] };
    isActive?: boolean;
  } = {};
  if (body.tokenCost !== undefined) patch.tokenCost = body.tokenCost;
  if (body.allowedParams !== undefined) patch.allowedParams = body.allowedParams;
  if (body.isActive !== undefined) patch.isActive = body.isActive;

  const [updated] = await db.update(aiModels).set(patch).where(eq(aiModels.id, id)).returning();
  if (!updated) throw notFound("Model tidak ditemukan.");

  return c.json(toModel(updated), 200);
});

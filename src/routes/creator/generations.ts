import { and, desc, eq, sql } from "drizzle-orm";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";

import { requireWorkspace, sessionGuard } from "../../auth/middleware.js";
import { db } from "../../db/client.js";
import { env } from "../../env.js";
import { expensiveLimiter } from "../../http/rate-limit.js";
import { aiModels, aiProviders, generations } from "../../db/schema.js";
import { notFound } from "../../http/errors.js";
import { defaultHook } from "../../http/route-helpers.js";
import { toGeneration, toModel } from "../../http/serialize.js";
import {
  AiModelSchema,
  CreateGenerationResponseSchema,
  ErrorResponseSchema,
  GenerationSchema,
  GenerationParamsSchema,
  PlanResponseSchema,
} from "../../http/schemas.js";
import type { AppBindings } from "../../http/types.js";
import {
  createGeneration,
  planGeneration,
  purgedMapFor,
} from "../../services/generation-service.js";
import { getAiSettings } from "../../services/settings.js";

export const creatorGenerationRoutes = new OpenAPIHono<AppBindings>({ defaultHook });

const errorContent = { "application/json": { schema: ErrorResponseSchema } };
const generationParams = z.object({ id: z.string().uuid() });

creatorGenerationRoutes.use("/models", sessionGuard(), requireWorkspace("MEMBER"));
creatorGenerationRoutes.use("/generations", sessionGuard(), requireWorkspace("MEMBER"));
creatorGenerationRoutes.use("/generations/*", sessionGuard(), requireWorkspace("MEMBER"));

/** Debug hook for refund drills; production ignores it entirely. */
function simulateFailureFromHeader(c: Context<AppBindings>): boolean {
  if (env.NODE_ENV === "production") return false;
  return c.req.header("x-simulate-failure") === "1";
}

const modelsRoute = createRoute({
  method: "get",
  path: "/models",
  tags: ["Creator catalog"],
  responses: {
    200: {
      description: "Active renderable models",
      content: { "application/json": { schema: z.array(AiModelSchema) } },
    },
  },
});

creatorGenerationRoutes.openapi(modelsRoute, async (c) => {
  const rows = await db
    .select({ model: aiModels })
    .from(aiModels)
    .innerJoin(aiProviders, eq(aiProviders.id, aiModels.providerId))
    .where(
      and(
        eq(aiModels.isActive, true),
        eq(aiProviders.isActive, true),
        sql`${aiModels.outputCapabilities} && ARRAY['IMAGE','VIDEO']::model_capability[]`,
      ),
    )
    .orderBy(aiModels.tokenCost, aiModels.displayName);

  const { defaultVideoModelId } = await getAiSettings(db);
  return c.json(
    rows.map((row) =>
      toModel(row.model, row.model.mediaType === "VIDEO" && row.model.id === defaultVideoModelId),
    ),
    200,
  );
});

const planRoute = createRoute({
  method: "post",
  path: "/generations/plan",
  tags: ["Creator generations"],
  middleware: [expensiveLimiter()] as const,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            folderId: z.string().uuid(),
            modelId: z.string().uuid(),
            rawPrompt: z.string(),
            durationSec: z.number().int().optional(),
            resolution: z.string(),
            aspectRatio: z.string(),
            attachmentKeys: z.array(z.string()).max(4).default([]),
            contextIds: z.array(z.string().uuid()).default([]),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Plan blueprint", content: { "application/json": { schema: PlanResponseSchema } } },
    400: { description: "Invalid model params", content: errorContent },
    404: { description: "Model not found", content: errorContent },
    409: { description: "Insufficient tokens", content: errorContent },
  },
});

creatorGenerationRoutes.openapi(planRoute, async (c) => {
  const auth = c.get("auth");
  const workspaceId = auth.workspaceId;
  if (!workspaceId) throw notFound("Workspace aktif tidak ditemukan.");
  const body = c.req.valid("json");

  const result = await planGeneration({
    workspaceId,
    userId: auth.user.id,
    folderId: body.folderId,
    modelId: body.modelId,
    rawPrompt: body.rawPrompt,
    durationSec: body.durationSec,
    resolution: body.resolution,
    aspectRatio: body.aspectRatio,
    attachmentKeys: body.attachmentKeys,
    contextIds: body.contextIds,
  });

  return c.json(result, 200);
});

const createGenerationRoute = createRoute({
  method: "post",
  path: "/generations",
  tags: ["Creator generations"],
  middleware: [expensiveLimiter()] as const,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            folderId: z.string().uuid(),
            modelId: z.string().uuid(),
            rawPrompt: z.string(),
            planMode: z.boolean().default(true),
            finalPrompt: z.string().nullable().optional(),
            attachmentKeys: z.array(z.string()).max(4).default([]),
            contextIds: z.array(z.string().uuid()).default([]),
            selectedParams: GenerationParamsSchema,
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Generation queued",
      content: { "application/json": { schema: CreateGenerationResponseSchema } },
    },
    400: { description: "Invalid payload", content: errorContent },
    404: { description: "Folder or model not found", content: errorContent },
    409: { description: "Insufficient tokens", content: errorContent },
    503: { description: "Queue unavailable", content: errorContent },
  },
});

creatorGenerationRoutes.openapi(createGenerationRoute, async (c) => {
  const auth = c.get("auth");
  const workspaceId = auth.workspaceId;
  if (!workspaceId) throw notFound("Workspace aktif tidak ditemukan.");
  const body = c.req.valid("json");

  const result = await createGeneration({
    workspaceId,
    userId: auth.user.id,
    folderId: body.folderId,
    modelId: body.modelId,
    rawPrompt: body.rawPrompt,
    planMode: body.planMode,
    finalPrompt: body.finalPrompt ?? null,
    attachmentKeys: body.attachmentKeys,
    contextIds: body.contextIds,
    selectedParams: body.selectedParams,
    simulateFailure: simulateFailureFromHeader(c),
  });

  return c.json({ generation: toGeneration(result.generation), workspace: result.workspace }, 201);
});

const getGenerationRoute = createRoute({
  method: "get",
  path: "/generations/{id}",
  tags: ["Creator generations"],
  request: { params: generationParams },
  responses: {
    200: { description: "Generation", content: { "application/json": { schema: GenerationSchema } } },
    404: { description: "Not found in this workspace", content: errorContent },
  },
});

creatorGenerationRoutes.openapi(getGenerationRoute, async (c) => {
  const auth = c.get("auth");
  const workspaceId = auth.workspaceId;
  if (!workspaceId) throw notFound("Workspace aktif tidak ditemukan.");
  const { id } = c.req.valid("param");

  const [row] = await db
    .select()
    .from(generations)
    .where(and(eq(generations.id, id), eq(generations.workspaceId, workspaceId)))
    .limit(1);
  if (!row) throw notFound("Generation tidak ditemukan.");

  const purged = await purgedMapFor([row.id]);
  return c.json(toGeneration(row, purged.get(row.id) ?? null), 200);
});

const deleteGenerationRoute = createRoute({
  method: "delete",
  path: "/generations/{id}",
  tags: ["Creator generations"],
  request: { params: generationParams },
  responses: {
    204: { description: "Generation deleted" },
    404: { description: "Not found in this workspace", content: errorContent },
  },
});

creatorGenerationRoutes.openapi(deleteGenerationRoute, async (c) => {
  const auth = c.get("auth");
  const workspaceId = auth.workspaceId;
  if (!workspaceId) throw notFound("Workspace aktif tidak ditemukan.");
  const { id } = c.req.valid("param");

  const [deleted] = await db
    .delete(generations)
    .where(and(eq(generations.id, id), eq(generations.workspaceId, workspaceId)))
    .returning({ id: generations.id });
  if (!deleted) throw notFound("Generation tidak ditemukan.");

  return c.body(null, 204);
});

const recentRoute = createRoute({
  method: "get",
  path: "/generations",
  tags: ["Creator generations"],
  responses: {
    200: {
      description: "Recent generations in the workspace",
      content: { "application/json": { schema: z.array(GenerationSchema) } },
    },
  },
});

creatorGenerationRoutes.openapi(recentRoute, async (c) => {
  const auth = c.get("auth");
  const workspaceId = auth.workspaceId;
  if (!workspaceId) throw notFound("Workspace aktif tidak ditemukan.");

  const rows = await db
    .select()
    .from(generations)
    .where(eq(generations.workspaceId, workspaceId))
    .orderBy(desc(generations.createdAt))
    .limit(50);

  const purged = await purgedMapFor(rows.map((row) => row.id));
  return c.json(
    rows.map((row) => toGeneration(row, purged.get(row.id) ?? null)),
    200,
  );
});

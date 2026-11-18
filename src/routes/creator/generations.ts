import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";

import { requireWorkspace, sessionGuard } from "../../auth/middleware.js";
import { db } from "../../db/client.js";
import { env } from "../../env.js";
import { expensiveLimiter } from "../../http/rate-limit.js";
import { aiModels, aiProviders, folders, generations } from "../../db/schema.js";
import { notFound } from "../../http/errors.js";
import { defaultHook } from "../../http/route-helpers.js";
import { toActiveGeneration, toGeneration, toModel } from "../../http/serialize.js";
import type { ActiveGenerationDto } from "../../http/schemas.js";
import {
  ActiveGenerationSchema,
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
import type { GenerationRow } from "../../db/schema.js";
import { estimateOf, estimatesForModels, progressFor } from "../../services/progress-service.js";
import type { RenderProgress } from "../../services/progress-service.js";
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
            continueFromPrevious: z.boolean().default(true),
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
    continueFromPrevious: body.continueFromPrevious,
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
            continueFromPrevious: z.boolean().default(true),
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
    continueFromPrevious: body.continueFromPrevious,
  });

  return c.json({ generation: toGeneration(result.generation), workspace: result.workspace }, 201);
});

const STREAM_POLL_MS = 2_000;
const STREAM_HEARTBEAT_MS = 10_000;
/** An idle workspace keeps the stream open one minute, then ends it; EventSource reconnects. */
const STREAM_IDLE_LIMIT_MS = 60_000;
/** A finished row can commit just after a poll read it, so each poll re-reads a small window. */
const STREAM_OVERLAP_MS = 5_000;
const STREAM_EMITTED_CAP = 500;

/**
 * Live render feed for the notification bell. Progress is derived from persisted state only
 * (`status`, `started_at`, `provider_status`); providers expose no percentage.
 *
 * Completion is reported from `completed_at`, not from the job leaving the active list: a render
 * shorter than the poll interval would otherwise never raise an alert.
 */
creatorGenerationRoutes.get("/generations/stream", (c) => {
  const auth = c.get("auth");
  const workspaceId = auth.workspaceId;
  if (!workspaceId) throw notFound("Workspace aktif tidak ditemukan.");

  c.header("Cache-Control", "no-cache, no-transform");
  c.header("X-Accel-Buffering", "no");

  return streamSSE(c, async (stream) => {
    let lastPayload = "";
    let lastHeartbeat = Date.now();
    let idleSince = Date.now();
    let checkpoint = new Date();
    const emitted = new Set<string>();

    while (!stream.closed) {
      const next = await loadActiveGenerations(workspaceId);
      const payload = JSON.stringify(next);
      if (payload !== lastPayload) {
        lastPayload = payload;
        await stream.writeSSE({ event: "generations", data: payload });
      }

      const checkedAt = new Date();
      const ended = await db
        .select()
        .from(generations)
        .where(
          and(
            eq(generations.workspaceId, workspaceId),
            gt(generations.completedAt, checkpoint),
            inArray(generations.status, ["COMPLETED", "FAILED"]),
          ),
        )
        .orderBy(asc(generations.completedAt));
      checkpoint = new Date(checkedAt.getTime() - STREAM_OVERLAP_MS);

      for (const row of ended) {
        if (emitted.has(row.id)) continue;
        if (emitted.size >= STREAM_EMITTED_CAP) emitted.clear();
        emitted.add(row.id);
        await stream.writeSSE({
          event: "finished",
          data: JSON.stringify(
            toGeneration(row, null, { estimateMs: null, progressPercent: 100 }),
          ),
        });
      }

      if (next.length > 0) {
        idleSince = Date.now();
      } else if (Date.now() - idleSince >= STREAM_IDLE_LIMIT_MS) {
        break;
      }

      if (Date.now() - lastHeartbeat >= STREAM_HEARTBEAT_MS) {
        lastHeartbeat = Date.now();
        await stream.writeSSE({ event: "heartbeat", data: String(lastHeartbeat) });
      }

      await stream.sleep(STREAM_POLL_MS);
    }
  });
});

/** One estimate lookup per distinct model, then a per-row percentage from persisted timestamps. */
async function withProgress(rows: GenerationRow[]): Promise<Map<string, RenderProgress>> {
  const estimates = await estimatesForModels(
    db,
    rows.map((row) => ({ id: row.modelId, mediaType: row.mediaType })),
  );
  const progress = new Map<string, RenderProgress>();
  for (const row of rows) {
    progress.set(row.id, progressFor(row, estimateOf(estimates, row)));
  }
  return progress;
}

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
  const progress = await withProgress([row]);
  const entry = progress.get(row.id) ?? { estimateMs: null, progressPercent: 0 };
  return c.json(toGeneration(row, purged.get(row.id) ?? null, entry), 200);
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
  request: {
    query: z.object({ active: z.enum(["true"]).optional() }),
  },
  responses: {
    200: {
      description: "Recent generations, or the workspace's in-flight ones with ?active=true",
      content: {
        "application/json": {
          schema: z.union([z.array(GenerationSchema), z.array(ActiveGenerationSchema)]),
        },
      },
    },
  },
});

/** In-flight rows scoped to one workspace, joined with the folder name the studio links back to. */
async function loadActiveGenerations(workspaceId: string): Promise<ActiveGenerationDto[]> {
  const rows = await db
    .select({ generation: generations, folderName: folders.name })
    .from(generations)
    .innerJoin(folders, eq(folders.id, generations.folderId))
    .where(
      and(
        eq(generations.workspaceId, workspaceId),
        inArray(generations.status, ["QUEUED", "RENDERING"]),
      ),
    )
    .orderBy(desc(generations.createdAt));

  const progress = await withProgress(rows.map((row) => row.generation));
  return rows.map((row) =>
    toActiveGeneration(
      row.generation,
      row.folderName,
      progress.get(row.generation.id) ?? { estimateMs: null, progressPercent: 0 },
    ),
  );
}

creatorGenerationRoutes.openapi(recentRoute, async (c) => {
  const auth = c.get("auth");
  const workspaceId = auth.workspaceId;
  if (!workspaceId) throw notFound("Workspace aktif tidak ditemukan.");

  if (c.req.valid("query").active === "true") {
    return c.json(await loadActiveGenerations(workspaceId), 200);
  }

  const rows = await db
    .select()
    .from(generations)
    .where(eq(generations.workspaceId, workspaceId))
    .orderBy(desc(generations.createdAt))
    .limit(50);

  const purged = await purgedMapFor(rows.map((row) => row.id));
  const progress = await withProgress(rows);
  return c.json(
    rows.map((row) =>
      toGeneration(
        row,
        purged.get(row.id) ?? null,
        progress.get(row.id) ?? { estimateMs: null, progressPercent: 0 },
      ),
    ),
    200,
  );
});

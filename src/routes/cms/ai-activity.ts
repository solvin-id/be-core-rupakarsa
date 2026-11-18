import { and, asc, desc, eq, gte, ilike, lte, or, sql } from "drizzle-orm";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { requireCms, sessionGuard } from "../../auth/middleware.js";
import { db } from "../../db/client.js";
import { aiActivityLogs, aiProviders, workspaces } from "../../db/schema.js";
import type { AiActivityLogRow } from "../../db/schema.js";
import { defaultHook } from "../../http/route-helpers.js";
import { AiActivityPageSchema, AiActivitySchema, ErrorResponseSchema } from "../../http/schemas.js";
import type { AppBindings } from "../../http/types.js";
import { AI_ACTIVITY_KINDS, AI_ACTIVITY_STATUSES } from "../../services/ai-activity-log.js";

export const cmsAiActivityRoutes = new OpenAPIHono<AppBindings>({ defaultHook });

const errorContent = { "application/json": { schema: ErrorResponseSchema } };

cmsAiActivityRoutes.use("/ai-activity", sessionGuard(), requireCms());

const listRoute = createRoute({
  method: "get",
  path: "/ai-activity",
  tags: ["CMS AI activity"],
  request: {
    query: z.object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(10).max(100).default(25),
      q: z.string().optional(),
      kind: z.enum(AI_ACTIVITY_KINDS).optional(),
      status: z.enum(AI_ACTIVITY_STATUSES).optional(),
      providerId: z.string().uuid().optional(),
      modelId: z.string().uuid().optional(),
      workspaceId: z.string().uuid().optional(),
      mediaType: z.enum(["VIDEO", "IMAGE"]).optional(),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
      orderBy: z.enum(["createdAt", "latencyMs", "tokensUsed"]).default("createdAt"),
      order: z.enum(["asc", "desc"]).default("desc"),
    }),
  },
  responses: {
    200: { description: "AI activity page", content: { "application/json": { schema: AiActivityPageSchema } } },
    401: { description: "No session", content: errorContent },
    403: { description: "No CMS access", content: errorContent },
  },
});

/** The kind/status columns are plain text; the DTO schema is what proves they are the enum. */
function toActivity(
  row: AiActivityLogRow,
  workspaceName: string | null,
  providerName: string | null,
) {
  return AiActivitySchema.parse({
    ...row,
    workspaceName,
    providerName,
    createdAt: row.createdAt.toISOString(),
  });
}

cmsAiActivityRoutes.openapi(listRoute, async (c) => {
  const query = c.req.valid("query");

  const conditions = [];
  if (query.kind) conditions.push(eq(aiActivityLogs.kind, query.kind));
  if (query.status) conditions.push(eq(aiActivityLogs.status, query.status));
  if (query.providerId) conditions.push(eq(aiActivityLogs.providerId, query.providerId));
  if (query.modelId) conditions.push(eq(aiActivityLogs.modelId, query.modelId));
  if (query.workspaceId) conditions.push(eq(aiActivityLogs.workspaceId, query.workspaceId));
  if (query.mediaType) conditions.push(eq(aiActivityLogs.mediaType, query.mediaType));
  if (query.from) conditions.push(gte(aiActivityLogs.createdAt, new Date(query.from)));
  if (query.to) conditions.push(lte(aiActivityLogs.createdAt, new Date(query.to)));
  if (query.q && query.q.trim().length > 0) {
    const needle = `%${query.q.trim()}%`;
    const match = or(
      ilike(aiActivityLogs.modelName, needle),
      ilike(aiActivityLogs.errorMessage, needle),
      ilike(aiActivityLogs.requestText, needle),
      ilike(aiActivityLogs.responseText, needle),
      ilike(aiActivityLogs.externalJobId, needle),
    );
    if (match) conditions.push(match);
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [stats] = await db
    .select({
      total: sql<number>`count(*)`.mapWith(Number),
      success: sql<number>`count(*) filter (where ${aiActivityLogs.status} = 'SUCCESS')`.mapWith(Number),
      error: sql<number>`count(*) filter (where ${aiActivityLogs.status} = 'ERROR')`.mapWith(Number),
      avgLatencyMs: sql<number>`coalesce(avg(${aiActivityLogs.latencyMs}), 0)`.mapWith(Number),
      tokensUsed: sql<number>`coalesce(sum(${aiActivityLogs.tokensUsed}), 0)`.mapWith(Number),
    })
    .from(aiActivityLogs)
    .where(where);

  const sortColumn =
    query.orderBy === "latencyMs"
      ? aiActivityLogs.latencyMs
      : query.orderBy === "tokensUsed"
        ? aiActivityLogs.tokensUsed
        : aiActivityLogs.createdAt;

  const rows = await db
    .select({
      row: aiActivityLogs,
      workspaceName: workspaces.name,
      providerName: aiProviders.name,
    })
    .from(aiActivityLogs)
    .leftJoin(workspaces, eq(workspaces.id, aiActivityLogs.workspaceId))
    .leftJoin(aiProviders, eq(aiProviders.id, aiActivityLogs.providerId))
    .where(where)
    .orderBy(query.order === "asc" ? asc(sortColumn) : desc(sortColumn))
    .limit(query.limit)
    .offset((query.page - 1) * query.limit);

  return c.json(
    {
      rows: rows.map((entry) => toActivity(entry.row, entry.workspaceName, entry.providerName)),
      total: stats?.total ?? 0,
      page: query.page,
      limit: query.limit,
      stats: {
        total: stats?.total ?? 0,
        success: stats?.success ?? 0,
        error: stats?.error ?? 0,
        avgLatencyMs: Math.round(stats?.avgLatencyMs ?? 0),
        tokensUsed: stats?.tokensUsed ?? 0,
      },
    },
    200,
  );
});

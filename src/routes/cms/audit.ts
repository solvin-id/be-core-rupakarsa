import { desc, lt } from "drizzle-orm";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { requireCms, sessionGuard } from "../../auth/middleware.js";
import { db } from "../../db/client.js";
import { auditLogs } from "../../db/schema.js";
import { defaultHook } from "../../http/route-helpers.js";
import { AuditLogSchema, ErrorResponseSchema } from "../../http/schemas.js";
import type { AppBindings } from "../../http/types.js";

export const cmsAuditRoutes = new OpenAPIHono<AppBindings>({ defaultHook });

const errorContent = { "application/json": { schema: ErrorResponseSchema } };

cmsAuditRoutes.use("/audit-logs", sessionGuard(), requireCms());

const listRoute = createRoute({
  method: "get",
  path: "/audit-logs",
  tags: ["CMS audit"],
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(200).default(50),
      before: z.string().optional(),
    }),
  },
  responses: {
    200: { description: "Audit trail", content: { "application/json": { schema: AuditLogSchema.array() } } },
    400: { description: "Invalid cursor", content: errorContent },
  },
});

cmsAuditRoutes.openapi(listRoute, async (c) => {
  const { limit, before } = c.req.valid("query");

  const beforeDate = before ? new Date(before) : null;
  if (before && Number.isNaN(beforeDate?.getTime() ?? NaN)) {
    return c.json({ error: { code: "VALIDATION_ERROR", message: "Cursor tidak valid." } }, 400);
  }

  const rows = await db
    .select()
    .from(auditLogs)
    .where(beforeDate ? lt(auditLogs.createdAt, beforeDate) : undefined)
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit);

  return c.json(
    rows.map((row) => ({
      id: row.id,
      actorUserId: row.actorUserId,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      metadata: row.metadata,
      ip: row.ip,
      createdAt: row.createdAt.toISOString(),
    })),
    200,
  );
});

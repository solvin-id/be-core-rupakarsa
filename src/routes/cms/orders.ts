import { desc, eq } from "drizzle-orm";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { requireCms, sessionGuard } from "../../auth/middleware.js";
import { db } from "../../db/client.js";
import { orders, workspaces } from "../../db/schema.js";
import { conflict, notFound } from "../../http/errors.js";
import { clientIp } from "../../http/middleware.js";
import { defaultHook } from "../../http/route-helpers.js";
import { CmsOrderSchema, ErrorResponseSchema, WorkspaceSchema } from "../../http/schemas.js";
import type { AppBindings } from "../../http/types.js";
import { logAudit } from "../../services/audit-service.js";
import { applyOrderPaid } from "../../services/billing-service.js";

export const cmsOrderRoutes = new OpenAPIHono<AppBindings>({ defaultHook });

const errorContent = { "application/json": { schema: ErrorResponseSchema } };
const orderParams = z.object({ id: z.string().uuid() });

cmsOrderRoutes.use("/orders", sessionGuard(), requireCms());
cmsOrderRoutes.use("/orders/*", sessionGuard(), requireCms());

const listRoute = createRoute({
  method: "get",
  path: "/orders",
  tags: ["CMS orders"],
  responses: {
    200: { description: "Recent orders with workspace names", content: { "application/json": { schema: CmsOrderSchema.array() } } },
  },
});

cmsOrderRoutes.openapi(listRoute, async (c) => {
  const rows = await db
    .select({ order: orders, workspace: workspaces })
    .from(orders)
    .innerJoin(workspaces, eq(workspaces.id, orders.workspaceId))
    .orderBy(desc(orders.createdAt))
    .limit(100);

  return c.json(
    rows.map((row) => ({
      id: row.order.id,
      workspaceId: row.order.workspaceId,
      userId: row.order.userId,
      tokens: row.order.tokens,
      planQuota: row.order.planQuota,
      amountRupiah: row.order.amountRupiah,
      provider: row.order.provider,
      providerRef: row.order.providerRef,
      status: row.order.status,
      paidAt: row.order.paidAt ? row.order.paidAt.toISOString() : null,
      createdAt: row.order.createdAt.toISOString(),
      workspaceName: row.workspace.name,
    })),
    200,
  );
});

const markPaidRoute = createRoute({
  method: "post",
  path: "/orders/{id}/mark-paid",
  tags: ["CMS orders"],
  request: { params: orderParams },
  responses: {
    200: { description: "Order settled", content: { "application/json": { schema: WorkspaceSchema } } },
    404: { description: "Order not found", content: errorContent },
    409: { description: "Order already settled", content: errorContent },
  },
});

cmsOrderRoutes.openapi(markPaidRoute, async (c) => {
  const auth = c.get("auth");
  const { id } = c.req.valid("param");

  const [order] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  if (!order) throw notFound("Order tidak ditemukan.");
  if (order.status !== "PENDING") throw conflict("Order ini sudah diproses.");

  const applied = await applyOrderPaid(db, order.id);
  if (!applied) throw conflict("Order ini sudah diproses.");

  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, order.workspaceId))
    .limit(1);
  if (!workspace) throw notFound("Workspace tidak ditemukan.");

  await logAudit(db, {
    actorUserId: auth.user.id,
    action: "order.mark_paid",
    targetType: "order",
    targetId: order.id,
    metadata: { tokens: order.tokens, planQuota: order.planQuota },
    ip: clientIp(c),
  });

  return c.json(
    {
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      tokenBalance: workspace.tokenBalance,
      freePlanRemaining: workspace.freePlanRemaining,
      isActive: workspace.isActive,
      createdAt: workspace.createdAt.toISOString(),
    },
    200,
  );
});

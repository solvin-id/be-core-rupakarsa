import { desc, eq } from "drizzle-orm";
import { OpenAPIHono, createRoute } from "@hono/zod-openapi";

import { requireWorkspace, sessionGuard } from "../../auth/middleware.js";
import { db } from "../../db/client.js";
import { orders } from "../../db/schema.js";
import { notFound } from "../../http/errors.js";
import { defaultHook } from "../../http/route-helpers.js";
import {
  CreateOrderResponseSchema,
  ErrorResponseSchema,
  OrderSchema,
  PackageSchema,
} from "../../http/schemas.js";
import type { AppBindings } from "../../http/types.js";
import { createOrder, listPackages } from "../../services/billing-service.js";

export const creatorBillingRoutes = new OpenAPIHono<AppBindings>({ defaultHook });

const errorContent = { "application/json": { schema: ErrorResponseSchema } };

creatorBillingRoutes.use("/billing", sessionGuard());
creatorBillingRoutes.use("/billing/*", sessionGuard());

function toOrder(row: typeof orders.$inferSelect) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    userId: row.userId,
    tokens: row.tokens,
    planQuota: row.planQuota,
    amountRupiah: row.amountRupiah,
    provider: row.provider,
    providerRef: row.providerRef,
    status: row.status,
    paidAt: row.paidAt ? row.paidAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

const packagesRoute = createRoute({
  method: "get",
  path: "/billing/packages",
  tags: ["Creator billing"],
  responses: {
    200: { description: "Available top-up packages", content: { "application/json": { schema: PackageSchema.array() } } },
  },
});

creatorBillingRoutes.openapi(packagesRoute, async (c) => {
  return c.json(await listPackages(db), 200);
});

const createOrderRoute = createRoute({
  method: "post",
  path: "/billing/orders",
  tags: ["Creator billing"],
  middleware: [requireWorkspace("MEMBER")] as const,
  request: {
    body: {
      content: {
        "application/json": { schema: PackageSchema.pick({ id: true }) },
      },
    },
  },
  responses: {
    201: { description: "Order created", content: { "application/json": { schema: CreateOrderResponseSchema } } },
    404: { description: "Package not found", content: errorContent },
    409: { description: "Payment provider not configured", content: errorContent },
  },
});

creatorBillingRoutes.openapi(createOrderRoute, async (c) => {
  const auth = c.get("auth");
  const workspaceId = auth.workspaceId;
  if (!workspaceId) throw notFound("Workspace aktif tidak ditemukan.");
  const body = c.req.valid("json");

  const result = await createOrder(db, {
    workspaceId,
    userId: auth.user.id,
    packageId: body.id,
  });

  return c.json({ order: toOrder(result.order), redirectUrl: result.redirectUrl }, 201);
});

const listOrdersRoute = createRoute({
  method: "get",
  path: "/billing/orders",
  tags: ["Creator billing"],
  middleware: [requireWorkspace("MEMBER")] as const,
  responses: {
    200: { description: "Recent orders of the active workspace", content: { "application/json": { schema: OrderSchema.array() } } },
  },
});

creatorBillingRoutes.openapi(listOrdersRoute, async (c) => {
  const auth = c.get("auth");
  const workspaceId = auth.workspaceId;
  if (!workspaceId) throw notFound("Workspace aktif tidak ditemukan.");

  const rows = await db
    .select()
    .from(orders)
    .where(eq(orders.workspaceId, workspaceId))
    .orderBy(desc(orders.createdAt))
    .limit(20);

  return c.json(rows.map(toOrder), 200);
});

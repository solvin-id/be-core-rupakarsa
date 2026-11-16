import { createHash } from "node:crypto";

import { eq } from "drizzle-orm";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { decryptSecret } from "../../crypto/encryption.js";
import { db } from "../../db/client.js";
import { orders } from "../../db/schema.js";
import { unauthorized } from "../../http/errors.js";
import { defaultHook } from "../../http/route-helpers.js";
import { ErrorResponseSchema } from "../../http/schemas.js";
import type { AppBindings } from "../../http/types.js";
import { applyOrderPaid, markOrderExpired } from "../../services/billing-service.js";
import { getPaymentSettings } from "../../services/settings.js";

export const publicPaymentRoutes = new OpenAPIHono<AppBindings>({ defaultHook });

const webhookRoute = createRoute({
  method: "post",
  path: "/api/public/midtrans/webhook",
  tags: ["Public"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            order_id: z.string(),
            status_code: z.string(),
            gross_amount: z.string(),
            signature_key: z.string(),
            transaction_status: z.string(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Acknowledged", content: { "application/json": { schema: z.object({ ok: z.boolean() }) } } },
    401: { description: "Invalid signature", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

publicPaymentRoutes.openapi(webhookRoute, async (c) => {
  const body = c.req.valid("json");
  const payment = await getPaymentSettings(db);
  if (payment.midtrans.serverKeyEncrypted.length === 0) throw unauthorized("Signature tidak valid.");

  const serverKey = decryptSecret(payment.midtrans.serverKeyEncrypted);
  const expected = createHash("sha512")
    .update(`${body.order_id}${body.status_code}${body.gross_amount}${serverKey}`)
    .digest("hex");
  if (expected !== body.signature_key) throw unauthorized("Signature tidak valid.");

  const [order] = await db.select().from(orders).where(eq(orders.id, body.order_id)).limit(1);
  if (!order) return c.json({ ok: true }, 200);

  if (body.transaction_status === "settlement" || body.transaction_status === "capture") {
    await applyOrderPaid(db, order.id);
  } else if (body.transaction_status === "expire") {
    await markOrderExpired(db, order.id, "EXPIRED");
  } else if (["cancel", "deny", "failure"].includes(body.transaction_status)) {
    await markOrderExpired(db, order.id, "FAILED");
  } else if (body.transaction_status === "pending") {
    // Still waiting for settlement; keep the order PENDING.
  }

  return c.json({ ok: true }, 200);
});

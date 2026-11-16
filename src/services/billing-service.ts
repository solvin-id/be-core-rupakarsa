import { eq } from "drizzle-orm";

import type { DbHandle } from "../db/client.js";
import { db } from "../db/client.js";
import { orders, tokenLedger, workspaces } from "../db/schema.js";
import type { OrderRow } from "../db/schema.js";
import { decryptSecret } from "../crypto/encryption.js";
import { AppError, conflict, notFound } from "../http/errors.js";
import { getPaymentSettings, getPricing } from "./settings.js";

export interface PackageOffer {
  id: string;
  tokens: number;
  planQuota: number;
  priceRupiah: number;
}

const PACKAGE_ID = "starter";
const SNAP_PRODUCTION = "https://app.midtrans.com/snap/v1/transactions";
const SNAP_SANDBOX = "https://app.sandbox.midtrans.com/snap/v1/transactions";

export async function listPackages(handle: DbHandle = db): Promise<PackageOffer[]> {
  const pricing = await getPricing(handle);
  return [
    {
      id: PACKAGE_ID,
      tokens: pricing.packageTokens,
      planQuota: pricing.packagePlanQuota,
      priceRupiah: pricing.tokenValueRupiah * pricing.packageTokens,
    },
  ];
}

function midtransBaseUrl(isProduction: boolean): string {
  return isProduction ? SNAP_PRODUCTION : SNAP_SANDBOX;
}

export async function createOrder(
  handle: DbHandle,
  input: { workspaceId: string; userId: string; packageId: string },
): Promise<{ order: OrderRow; redirectUrl: string | null }> {
  const offers = await listPackages(handle);
  const offer = offers.find((row) => row.id === input.packageId);
  if (!offer) throw notFound("Paket tidak ditemukan.");

  const payment = await getPaymentSettings(handle);
  const [order] = await handle
    .insert(orders)
    .values({
      workspaceId: input.workspaceId,
      userId: input.userId,
      tokens: offer.tokens,
      planQuota: offer.planQuota,
      amountRupiah: offer.priceRupiah,
      provider: payment.driver,
      status: "PENDING",
    })
    .returning();
  if (!order) throw conflict("Order gagal dibuat.");

  if (payment.driver !== "MIDTRANS") return { order, redirectUrl: null };

  if (payment.midtrans.serverKeyEncrypted.length === 0) {
    throw new AppError(
      409,
      "PAYMENT_NOT_CONFIGURED",
      "Midtrans belum dikonfigurasi. Hubungi admin untuk top-up manual.",
    );
  }

  const serverKey = decryptSecret(payment.midtrans.serverKeyEncrypted);
  const response = await fetch(midtransBaseUrl(payment.midtrans.isProduction), {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${serverKey}:`).toString("base64")}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      transaction_details: { order_id: order.id, gross_amount: offer.priceRupiah },
      item_details: [
        {
          id: offer.id,
          price: offer.priceRupiah,
          quantity: 1,
          name: `Rupakarsa ${offer.tokens} token`,
        },
      ],
    }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    throw new AppError(502, "PAYMENT_ERROR", `Midtrans membalas ${response.status}.`);
  }

  const payload = (await response.json()) as { token?: unknown; redirect_url?: unknown };
  const token = typeof payload.token === "string" ? payload.token : "";
  if (token.length === 0) throw new AppError(502, "PAYMENT_ERROR", "Midtrans tidak mengembalikan token.");

  await handle.update(orders).set({ providerRef: token }).where(eq(orders.id, order.id));
  const redirectUrl =
    typeof payload.redirect_url === "string"
      ? payload.redirect_url
      : `${midtransBaseUrl(payment.midtrans.isProduction)}/${token}/redirect`;

  return { order: { ...order, providerRef: token }, redirectUrl };
}

/** Idempotent: a second settlement callback never credits the workspace twice. */
export async function applyOrderPaid(handle: DbHandle, orderId: string): Promise<boolean> {
  return await handle.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update").limit(1);
    if (!order) throw notFound("Order tidak ditemukan.");
    if (order.status !== "PENDING") return false;

    await tx
      .update(orders)
      .set({ status: "PAID", paidAt: new Date() })
      .where(eq(orders.id, order.id));

    const [workspace] = await tx
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, order.workspaceId))
      .for("update")
      .limit(1);
    if (!workspace) throw notFound("Workspace tidak ditemukan.");

    const tokenBalance = workspace.tokenBalance + order.tokens;
    const freePlanRemaining = workspace.freePlanRemaining + order.planQuota;

    await tx
      .update(workspaces)
      .set({ tokenBalance, freePlanRemaining })
      .where(eq(workspaces.id, workspace.id));

    if (order.tokens > 0) {
      await tx.insert(tokenLedger).values({
        workspaceId: workspace.id,
        userId: order.userId,
        txType: "TOPUP",
        amount: order.tokens,
        balanceAfter: tokenBalance,
        notes: order.planQuota > 0 ? `order:${order.id} plan:+${order.planQuota}` : `order:${order.id}`,
      });
    }

    return true;
  });
}

export async function markOrderExpired(handle: DbHandle, orderId: string, status: "EXPIRED" | "FAILED"): Promise<void> {
  await handle
    .update(orders)
    .set({ status })
    .where(eq(orders.id, orderId));
}

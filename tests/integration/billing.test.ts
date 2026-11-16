import { createHash } from "node:crypto";

import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { encryptSecret } from "../../src/crypto/encryption.js";
import { db } from "../../src/db/client.js";
import { orders, tokenLedger, workspaces } from "../../src/db/schema.js";
import { env } from "../../src/env.js";
import { SETTING_KEYS, writeSetting } from "../../src/services/settings.js";
import {
  createAccount,
  createClient,
  jsonBody,
  login,
  resetDatabase,
} from "./helpers.js";
import type { TestClient } from "./helpers.js";

async function adminClient(): Promise<TestClient> {
  const client = createClient();
  await login(client, env.SEED_SUPERADMIN_EMAIL, env.SEED_SUPERADMIN_PASSWORD);
  return client;
}

async function workspaceOf(id: string) {
  const [row] = await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
  return row;
}

describe("billing", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("prices the package from the pricing setting and settles a manual order once", async () => {
    const account = await createAccount({ email: "billing@example.test" });
    const client = createClient();
    await login(client, "billing@example.test");

    const packages = await client.json<Array<{ id: string; tokens: number; planQuota: number; priceRupiah: number }>>(
      "/api/creator/billing/packages",
    );
    expect(packages.status).toBe(200);
    expect(packages.body).toHaveLength(1);
    expect(packages.body[0]).toMatchObject({ id: "starter", tokens: 4000, planQuota: 250 });
    expect(packages.body[0]?.priceRupiah).toBe(500 * 4000);

    const created = await client.json<{ order: { id: string; status: string }; redirectUrl: string | null }>(
      "/api/creator/billing/orders",
      jsonBody({ id: "starter" }),
    );
    expect(created.status).toBe(201);
    expect(created.body.order.status).toBe("PENDING");
    expect(created.body.redirectUrl).toBeNull();

    const listed = await client.json<Array<{ id: string; status: string }>>("/api/creator/billing/orders");
    expect(listed.body).toHaveLength(1);

    const admin = await adminClient();
    const settled = await admin.json<{ tokenBalance: number; freePlanRemaining: number }>(
      `/api/cms/orders/${created.body.order.id}/mark-paid`,
      { method: "POST" },
    );
    expect(settled.status).toBe(200);
    expect(settled.body.tokenBalance).toBe(4000);
    expect(settled.body.freePlanRemaining).toBe(250);

    const again = await admin.json<{ error: { message: string } }>(
      `/api/cms/orders/${created.body.order.id}/mark-paid`,
      { method: "POST" },
    );
    expect(again.status).toBe(409);
    expect(again.body.error.message).toBe("Order ini sudah diproses.");

    const row = await workspaceOf(account.workspace.id);
    expect(row?.tokenBalance).toBe(4000);

    const ledger = await db
      .select()
      .from(tokenLedger)
      .where(eq(tokenLedger.workspaceId, account.workspace.id));
    expect(ledger.filter((entry) => entry.txType === "TOPUP")).toHaveLength(1);
  });

  it("verifies the Midtrans signature and settles idempotently", async () => {
    const account = await createAccount({ email: "midtrans@example.test" });
    const client = createClient();
    await login(client, "midtrans@example.test");
    const created = await client.json<{ order: { id: string } }>(
      "/api/creator/billing/orders",
      jsonBody({ id: "starter" }),
    );

    await writeSetting(db, SETTING_KEYS.payment, {
      driver: "MIDTRANS",
      midtrans: { serverKeyEncrypted: encryptSecret("server-key"), clientKey: "client-key", isProduction: false },
    });

    const [order] = await db.select().from(orders).where(eq(orders.id, created.body.order.id)).limit(1);
    const grossAmount = String(order?.amountRupiah ?? 0);

    const publicClient = createClient();
    const badSignature = await publicClient.json<{ error: { message: string } }>(
      "/api/public/midtrans/webhook",
      jsonBody({
        order_id: created.body.order.id,
        status_code: "200",
        gross_amount: grossAmount,
        transaction_status: "settlement",
        signature_key: "0".repeat(128),
      }),
    );
    expect(badSignature.status).toBe(401);

    const signature = createHash("sha512")
      .update(`${created.body.order.id}200${grossAmount}server-key`)
      .digest("hex");

    const settled = await publicClient.json<{ ok: boolean }>("/api/public/midtrans/webhook", {
      ...jsonBody({
        order_id: created.body.order.id,
        status_code: "200",
        gross_amount: grossAmount,
        transaction_status: "settlement",
        signature_key: signature,
      }),
    });
    expect(settled.status).toBe(200);
    expect(settled.body.ok).toBe(true);

    const replay = await publicClient.json<{ ok: boolean }>("/api/public/midtrans/webhook", {
      ...jsonBody({
        order_id: created.body.order.id,
        status_code: "200",
        gross_amount: grossAmount,
        transaction_status: "settlement",
        signature_key: signature,
      }),
    });
    expect(replay.status).toBe(200);

    const row = await workspaceOf(account.workspace.id);
    expect(row?.tokenBalance).toBe(4000);
    expect(row?.freePlanRemaining).toBe(250);
  });
});

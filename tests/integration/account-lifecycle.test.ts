import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "../../src/db/client.js";
import { users } from "../../src/db/schema.js";
import { purgeDeletedAccounts } from "../../src/routes/creator/account.js";
import { createAccount, createClient, jsonBody, login, resetDatabase } from "./helpers.js";

describe("account lifecycle", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("exports the caller data without credential hashes", async () => {
    await createAccount({ email: "export@example.test" });
    const client = createClient();
    await login(client, "export@example.test");

    const exported = await client.json<{
      user: Record<string, unknown>;
      workspaces: unknown[];
      memberships: unknown[];
      folders: unknown[];
      generations: unknown[];
      contexts: unknown[];
    }>("/api/creator/account/export");

    expect(exported.status).toBe(200);
    expect(exported.body.workspaces.length).toBeGreaterThan(0);
    expect(exported.body.memberships.length).toBeGreaterThan(0);
    expect(exported.body.user.email).toBe("export@example.test");
    expect(JSON.stringify(exported.body)).not.toContain("passwordHash");
    expect(JSON.stringify(exported.body)).not.toContain("scrypt$");
  });

  it("soft-deletes on a correct password and purges after the retention window", async () => {
    await createAccount({ email: "delete@example.test" });
    const client = createClient();
    await login(client, "delete@example.test");

    const wrong = await client.json<{ error: { message: string } }>("/api/creator/account", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "salah-sekali" }),
    });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.message).toBe("Password salah.");

    const deleted = await client.request("/api/creator/account", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "rupakarsa" }),
    });
    expect(deleted.status).toBe(204);

    const [row] = await db.select().from(users).where(eq(users.email, "delete@example.test")).limit(1);
    expect(row?.deletedAt).not.toBeNull();
    expect(row?.isActive).toBe(false);

    const relogin = createClient();
    const blocked = await relogin.json<{ error: { message: string } }>(
      "/api/creator/auth/login",
      jsonBody({ email: "delete@example.test", password: "rupakarsa" }),
    );
    expect(blocked.status).toBe(401);

    expect(await purgeDeletedAccounts()).toBe(0);

    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    await db.update(users).set({ deletedAt: old }).where(eq(users.id, row?.id ?? ""));
    expect(await purgeDeletedAccounts()).toBe(1);

    const remaining = await db.select().from(users).where(eq(users.email, "delete@example.test"));
    expect(remaining).toHaveLength(0);
  });
});

import { desc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "../../src/db/client.js";
import { emailOutbox, passwordResetTokens, users } from "../../src/db/schema.js";
import { env } from "../../src/env.js";
import { createAccount, createClient, jsonBody, login, resetDatabase } from "./helpers.js";
import type { TestClient } from "./helpers.js";

function tokenFromBody(body: string): string {
  const match = /[?&]token=([A-Za-z0-9_-]+)/.exec(body);
  if (!match?.[1]) throw new Error(`no token in: ${body}`);
  return match[1];
}

async function adminClient(): Promise<TestClient> {
  const client = createClient();
  await login(client, env.SEED_SUPERADMIN_EMAIL, env.SEED_SUPERADMIN_PASSWORD);
  return client;
}

describe("password reset", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("never reveals whether an email exists", async () => {
    const client = createClient();
    const response = await client.json<{ ok: boolean }>(
      "/api/creator/auth/password-reset/request",
      jsonBody({ email: "tidak-ada@example.test" }),
    );

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(await db.select().from(passwordResetTokens)).toHaveLength(0);
    expect(await db.select().from(emailOutbox)).toHaveLength(0);
  });

  it("emails a link that replaces the password exactly once", async () => {
    await createAccount({ email: "reset@example.test", password: "PasswordLama1" });
    const client = createClient();

    const requested = await client.json<{ ok: boolean }>(
      "/api/creator/auth/password-reset/request",
      jsonBody({ email: "reset@example.test" }),
    );
    expect(requested.status).toBe(200);

    const [outbox] = await db.select().from(emailOutbox).orderBy(desc(emailOutbox.createdAt)).limit(1);
    expect(outbox?.status).toBe("SENT");
    expect(outbox?.template).toBe("PASSWORD_RESET");
    const token = tokenFromBody(outbox?.bodyText ?? "");

    const [tokenRow] = await db.select().from(passwordResetTokens).limit(1);
    expect(tokenRow?.usedAt).toBeNull();
    expect(tokenRow?.tokenHash).not.toBe(token);

    const confirm = await client.request("/api/creator/auth/password-reset/confirm", {
      ...jsonBody({ token, newPassword: "PasswordBaru123" }),
    });
    expect(confirm.status).toBe(204);

    const stale = createClient();
    const oldLogin = await stale.json<{ error: { message: string } }>(
      "/api/creator/auth/login",
      jsonBody({ email: "reset@example.test", password: "PasswordLama1" }),
    );
    expect(oldLogin.status).toBe(401);

    const fresh = createClient();
    const newLogin = await login(fresh, "reset@example.test", "PasswordBaru123");
    expect(newLogin.user.email).toBe("reset@example.test");

    const reused = await client.json<{ error: { message: string } }>(
      "/api/creator/auth/password-reset/confirm",
      jsonBody({ token, newPassword: "PasswordLain123" }),
    );
    expect(reused.status).toBe(400);
    expect(reused.body.error.message).toBe("Link reset password tidak valid atau kedaluwarsa.");
  });

  it("requires a policy-compliant new password", async () => {
    await createAccount({ email: "policy@example.test", password: "PasswordLama1" });
    const client = createClient();
    await client.json("/api/creator/auth/password-reset/request", jsonBody({ email: "policy@example.test" }));
    const [outbox] = await db.select().from(emailOutbox).orderBy(desc(emailOutbox.createdAt)).limit(1);
    const token = tokenFromBody(outbox?.bodyText ?? "");

    const weak = await client.json<{ error: { message: string } }>(
      "/api/creator/auth/password-reset/confirm",
      jsonBody({ token, newPassword: "pendek" }),
    );
    expect(weak.status).toBe(400);
    expect(weak.body.error.message).toBe(
      "Password minimal 10 karakter dan harus memuat huruf dan angka.",
    );

    const [row] = await db.select().from(users).where(eq(users.email, "policy@example.test")).limit(1);
    expect(row?.passwordHash).toBeTruthy();
  });

  it("creates accounts with an operator-set password and emails the credentials", async () => {
    const admin = await adminClient();
    const created = await admin.json<{ account: { id: string; email: string }; temporaryPassword: string }>(
      "/api/cms/accounts",
      jsonBody({
        fullName: "Kreator Kustom",
        email: "kustom@example.test",
        role: "USER",
        cmsAccess: false,
        password: "RahasiaKuat123",
      }),
    );

    expect(created.status).toBe(201);
    expect(created.body.temporaryPassword).toBe("RahasiaKuat123");

    const [outbox] = await db.select().from(emailOutbox).orderBy(desc(emailOutbox.createdAt)).limit(1);
    expect(outbox?.template).toBe("ACCOUNT_CREATED");
    expect(outbox?.bodyText).toContain("RahasiaKuat123");

    const creator = createClient();
    const session = await login(creator, "kustom@example.test", "RahasiaKuat123");
    expect(session.user.email).toBe("kustom@example.test");

    const weak = await admin.json<{ error: { message: string } }>(
      "/api/cms/accounts",
      jsonBody({
        fullName: "Lemah",
        email: "lemah@example.test",
        role: "USER",
        cmsAccess: false,
        password: "pendek",
      }),
    );
    expect(weak.status).toBe(400);
    expect(weak.body.error.message).toBe(
      "Password minimal 10 karakter dan harus memuat huruf dan angka.",
    );
  });
});

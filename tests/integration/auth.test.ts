import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "../../src/db/client.js";
import { users } from "../../src/db/schema.js";
import {
  createAccount,
  createClient,
  jsonBody,
  login,
  resetDatabase,
  TEST_PASSWORD,
} from "./helpers.js";

describe("creator auth", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("logs in, sets an HttpOnly session cookie, and returns the session payload", async () => {
    const account = await createAccount({ email: "demo@example.test", fullName: "Demo Kreator" });
    const client = createClient();

    const response = await client.request("/api/creator/auth/login", {
      ...jsonBody({ email: "demo@example.test", password: TEST_PASSWORD }),
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
    });

    expect(response.status).toBe(200);
    const setCookie = response.headers.getSetCookie?.().join("; ") ?? "";
    expect(setCookie).toContain("rupakarsa_session=");
    expect(setCookie.toLowerCase()).toContain("httponly");
    expect(setCookie).toContain("SameSite=Lax");

    const body = (await response.json()) as {
      user: { email: string };
      workspace: { id: string };
      workspaces: unknown[];
      activeWorkspaceRole: string;
    };
    expect(body.user.email).toBe("demo@example.test");
    expect(body.workspace.id).toBe(account.workspace.id);
    expect(body.workspaces).toHaveLength(1);
    expect(body.activeWorkspaceRole).toBe("OWNER");
  });

  it("rejects a wrong password", async () => {
    await createAccount({ email: "demo@example.test" });
    const client = createClient();

    const response = await client.json<{ error: { code: string; message: string } }>(
      "/api/creator/auth/login",
      jsonBody({ email: "demo@example.test", password: "salah-sekali" }),
    );

    expect(response.status).toBe(401);
    expect(response.body.error.message).toBe("Akun tidak ditemukan atau password salah.");
  });

  it("rejects an inactive account", async () => {
    await createAccount({ email: "nonaktif@example.test" });
    await db.update(users).set({ isActive: false }).where(eq(users.email, "nonaktif@example.test"));

    const client = createClient();
    const response = await client.json<{ error: { message: string } }>(
      "/api/creator/auth/login",
      jsonBody({ email: "nonaktif@example.test", password: TEST_PASSWORD }),
    );

    expect(response.status).toBe(401);
    expect(response.body.error.message).toBe("Akun ini sedang tidak aktif. Hubungi Superadmin.");
  });

  it("requires a session for /creator/session", async () => {
    const client = createClient();
    const response = await client.json<{ error: { code: string } }>("/api/creator/session");
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("clears the session on logout and blocks the cookie afterwards", async () => {
    await createAccount({ email: "demo@example.test" });
    const client = createClient();
    await login(client, "demo@example.test");

    const logout = await client.request("/api/creator/auth/logout", { method: "POST" });
    expect(logout.status).toBe(204);

    const after = await client.json<{ error: { code: string } }>("/api/creator/session");
    expect(after.status).toBe(401);
  });

  it("changes the password and revokes other sessions", async () => {
    await createAccount({ email: "demo@example.test" });
    const first = createClient();
    const second = createClient();
    await login(first, "demo@example.test");
    await login(second, "demo@example.test");

    const change = await first.json<undefined>("/api/creator/auth/password", {
      ...jsonBody({ currentPassword: TEST_PASSWORD, newPassword: "password-baru-123" }),
      method: "POST",
    });
    expect(change.status).toBe(204);

    const revoked = await second.json<{ error: { code: string } }>("/api/creator/session");
    expect(revoked.status).toBe(401);

    const client = createClient();
    const relogin = await login(client, "demo@example.test", "password-baru-123");
    expect(relogin.user.email).toBe("demo@example.test");
  });

  it("rejects a wrong current password", async () => {
    await createAccount({ email: "demo@example.test" });
    const client = createClient();
    await login(client, "demo@example.test");

    const response = await client.json<{ error: { message: string } }>("/api/creator/auth/password", {
      ...jsonBody({ currentPassword: "salah", newPassword: "password-baru-123" }),
      method: "POST",
    });

    expect(response.status).toBe(401);
    expect(response.body.error.message).toBe("Password saat ini salah.");
  });
});

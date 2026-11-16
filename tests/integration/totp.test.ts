import { eq } from "drizzle-orm";
import { generate } from "otplib";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "../../src/db/client.js";
import { users } from "../../src/db/schema.js";
import { env } from "../../src/env.js";
import { SETTING_KEYS, writeSetting } from "../../src/services/settings.js";
import { createAccount, createClient, jsonBody, login, resetDatabase } from "./helpers.js";


describe("two-factor authentication", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("enrols, activates, and requires the second factor at login", async () => {
    await createAccount({ email: "totp@example.test" });
    const client = createClient();
    await login(client, "totp@example.test");

    const enroll = await client.json<{ secret: string; otpauthUrl: string; qrDataUrl: string }>(
      "/api/creator/auth/totp/enroll",
      { method: "POST" },
    );
    expect(enroll.status).toBe(200);
    expect(enroll.body.otpauthUrl).toContain("otpauth://totp/");
    expect(enroll.body.qrDataUrl.startsWith("data:image/png;base64,")).toBe(true);

    const [pending] = await db.select().from(users).where(eq(users.email, "totp@example.test")).limit(1);
    expect(pending?.totpEnabled).toBe(false);
    expect(pending?.totpSecretEncrypted).not.toBe(enroll.body.secret);

    const activate = await client.request("/api/creator/auth/totp/activate", {
      ...jsonBody({ code: "000000" }),
    });
    expect(activate.status).toBe(400);

    const goodCode = await generate({ secret: enroll.body.secret });
    const activated = await client.request("/api/creator/auth/totp/activate", {
      ...jsonBody({ code: goodCode }),
    });
    expect(activated.status).toBe(204);

    const fresh = createClient();
    const challenged = await fresh.json<{ totpRequired: boolean; challengeToken: string }>(
      "/api/creator/auth/login",
      jsonBody({ email: "totp@example.test", password: "rupakarsa" }),
    );
    expect(challenged.status).toBe(200);
    expect(challenged.body.totpRequired).toBe(true);
    expect(challenged.body.challengeToken.length).toBeGreaterThan(20);

    const wrong = await fresh.json<{ error: { message: string } }>(
      "/api/creator/auth/totp/challenge",
      jsonBody({ challengeToken: challenged.body.challengeToken, code: "000000" }),
    );
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.message).toBe("Token verifikasi 2FA tidak valid.");

    const code = await generate({ secret: enroll.body.secret });
    const session = await fresh.json<{ user: { email: string } }>(
      "/api/creator/auth/totp/challenge",
      jsonBody({ challengeToken: challenged.body.challengeToken, code }),
    );
    expect(session.status).toBe(200);
    expect(session.body.user.email).toBe("totp@example.test");

    const replay = await fresh.json<{ error: { message: string } }>(
      "/api/creator/auth/totp/challenge",
      jsonBody({ challengeToken: challenged.body.challengeToken, code }),
    );
    expect(replay.status).toBe(401);
    expect(replay.body.error.message).toBe("Sesi verifikasi 2FA kedaluwarsa. Masuk ulang.");
  });

  it("blocks CMS access until 2FA is enabled when the policy requires it", async () => {
    await writeSetting(db, SETTING_KEYS.security, {
      requireTotpForCms: true,
      rateLimitFailClosed: false,
    });

    const admin = createClient();
    await login(admin, env.SEED_SUPERADMIN_EMAIL, env.SEED_SUPERADMIN_PASSWORD);

    const blocked = await admin.json<{ error: { message: string } }>("/api/cms/accounts");
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.message).toBe("Aktifkan 2FA terlebih dahulu di Creator → Keamanan.");

    const enroll = await admin.json<{ secret: string }>("/api/creator/auth/totp/enroll", {
      method: "POST",
    });
    const code = await generate({ secret: enroll.body.secret });
    await admin.request("/api/creator/auth/totp/activate", { ...jsonBody({ code }) });

    const allowed = await admin.json<unknown[]>("/api/cms/accounts");
    expect(allowed.status).toBe(200);
  });
});

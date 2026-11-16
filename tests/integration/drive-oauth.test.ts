import { once } from "node:events";

import { eq } from "drizzle-orm";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";

import type { TestClient } from "./helpers.js";

// The Google endpoints are read from env when a module first imports `env`, so the mock provider has
// to be listening (and its URLs published) before any `src/` module is imported.
interface TokenCall {
  grantType: string;
  code?: string;
  refreshToken?: string;
  redirectUri?: string;
}

const folders: Array<{ id: string; name: string }> = [];
const tokenCalls: TokenCall[] = [];
const uploads: Array<{ id: string; name: string }> = [];
const revoked: string[] = [];
const userinfoCalls: string[] = [];

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const mock = new Hono();

mock.get("/authorize", (c) => c.text("consent"));

mock.post("/token", async (c) => {
  const form = new URLSearchParams(await c.req.text());
  tokenCalls.push({
    grantType: form.get("grant_type") ?? "",
    code: form.get("code") ?? undefined,
    refreshToken: form.get("refresh_token") ?? undefined,
    redirectUri: form.get("redirect_uri") ?? undefined,
  });
  if (form.get("grant_type") === "refresh_token") {
    return c.json({ access_token: "access-refreshed", expires_in: 3600 });
  }
  return c.json({
    access_token: "access-consent",
    refresh_token: "refresh-consent",
    expires_in: 3600,
    scope: "openid email https://www.googleapis.com/auth/drive.file",
  });
});

mock.get("/userinfo", (c) => {
  userinfoCalls.push(c.req.header("authorization") ?? "");
  return c.json({ email: "owner@example.test" });
});

mock.get("/drive/v3/files", (c) => c.json({ files: folders }));

mock.post("/drive/v3/files", async (c) => {
  const body = (await c.req.json()) as { name?: string };
  const created = { id: `folder-${folders.length + 1}`, name: body.name ?? "" };
  folders.push(created);
  return c.json(created);
});

mock.get("/drive/v3/files/:id", (c) => {
  const id = c.req.param("id");
  if (c.req.query("alt") === "media") {
    return c.body(new Uint8Array(PNG_BYTES), 200, { "content-type": "image/png" });
  }
  const folder = folders.find((item) => item.id === id);
  return folder ? c.json(folder) : c.json({ error: "not found" }, 404);
});

mock.delete("/drive/v3/files/:id", (c) => c.body(null, 204));

mock.post("/drive/v3/files/:id/permissions", (c) => c.json({ role: "reader", type: "anyone" }));

mock.post("/upload/drive/v3/files", async (c) => {
  const created = { id: `file-${uploads.length + 1}`, name: "upload" };
  uploads.push(created);
  return c.json(created);
});

mock.post("/revoke", (c) => {
  revoked.push(c.req.query("token") ?? "");
  return c.json({ ok: true });
});

const server = serve({ fetch: mock.fetch, port: 0 });
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") throw new Error("google mock did not bind");
const mockBase = `http://127.0.0.1:${address.port}`;

process.env.GOOGLE_OAUTH_AUTH_URL = `${mockBase}/authorize`;
process.env.GOOGLE_OAUTH_TOKEN_URL = `${mockBase}/token`;
process.env.GOOGLE_USERINFO_URL = `${mockBase}/userinfo`;
process.env.GOOGLE_DRIVE_API_URL = `${mockBase}/drive/v3`;
process.env.GOOGLE_DRIVE_UPLOAD_URL = `${mockBase}/upload/drive/v3`;
process.env.GOOGLE_REVOKE_URL = `${mockBase}/revoke`;

const { db } = await import("../../src/db/client.js");
const { mediaAssets, workspaceMemberships, workspaceStorage } = await import("../../src/db/schema.js");
const { env } = await import("../../src/env.js");
const { clearStorageCache } = await import("../../src/services/storage-service.js");
const helpers = await import("./helpers.js");

interface DriveStatusBody {
  connected: boolean;
  oauthConfigured: boolean;
  googleEmail: string;
  folderId: string;
  folderName: string;
  folderUrl: string;
  connectedAt: string | null;
  lastError: string | null;
  defaultStorage: { kind: "s3" | "local"; retentionDays: number };
}

async function adminClient(): Promise<TestClient> {
  const client = helpers.createClient();
  await helpers.login(client, env.SEED_SUPERADMIN_EMAIL, env.SEED_SUPERADMIN_PASSWORD);
  return client;
}

async function saveStorageSettings(client: TestClient, gdrive: { clientId: string; clientSecret?: string }) {
  const saved = await client.json<{ gdrive: { configured: boolean; redirectUri: string } }>(
    "/api/cms/settings/storage",
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        driver: "local",
        retentionDays: 0,
        s3: {
          endpoint: "",
          region: "auto",
          bucket: "",
          accessKeyId: "",
          publicBaseUrl: "",
          forcePathStyle: true,
        },
        gdrive,
      }),
    },
  );
  return saved;
}

async function startConsent(client: TestClient, workspaceId: string): Promise<{ status: number; url: string }> {
  const response = await client.json<{ url: string }>(
    `/api/creator/workspaces/${workspaceId}/storage/drive/start`,
    { method: "POST" },
  );
  return { status: response.status, url: response.body?.url ?? "" };
}

async function callback(client: TestClient, state: string, code = "ok"): Promise<Response> {
  return client.request(
    `/api/public/google/oauth/callback?state=${encodeURIComponent(state)}&code=${code}`,
  );
}

describe("google drive oauth per workspace", () => {
  beforeEach(async () => {
    tokenCalls.length = 0;
    uploads.length = 0;
    revoked.length = 0;
    userinfoCalls.length = 0;
    folders.length = 0;
    clearStorageCache();
    await helpers.resetDatabase();
  });

  it("connects a workspace through consent, stores media in Drive, then disconnects", async () => {
    const account = await helpers.createAccount({ email: "drive-owner@example.test" });
    const owner = helpers.createClient();
    await helpers.login(owner, account.user.email);
    const admin = await adminClient();

    // 1. Without an OAuth client the flow must refuse instead of building a broken URL.
    const initialStatus = await owner.json<DriveStatusBody>(
      `/api/creator/workspaces/${account.workspace.id}/storage/drive`,
    );
    expect(initialStatus.status).toBe(200);
    expect(initialStatus.body).toMatchObject({
      connected: false,
      oauthConfigured: false,
      googleEmail: "",
      folderUrl: "",
      lastError: null,
      defaultStorage: { kind: "local", retentionDays: 0 },
    });

    const notConfigured = await owner.json<{ error: { code: string; message: string } }>(
      `/api/creator/workspaces/${account.workspace.id}/storage/drive/start`,
      { method: "POST" },
    );
    expect(notConfigured.status).toBe(409);
    expect(notConfigured.body.error.code).toBe("GDRIVE_NOT_CONFIGURED");
    expect(notConfigured.body.error.message).toBe(
      "Google OAuth belum dikonfigurasi. Setel Client ID dan Client Secret di CMS → Storage.",
    );

    // 2. Admin stores the OAuth client; start returns a consent URL naming the workspace state.
    const saved = await saveStorageSettings(admin, {
      clientId: "client-123.apps.googleusercontent.com",
      clientSecret: "secret-123",
    });
    expect(saved.status).toBe(200);
    expect(saved.body.gdrive.configured).toBe(true);
    expect(saved.body.gdrive.redirectUri).toBe(`${env.PUBLIC_API_URL}/api/public/google/oauth/callback`);

    const started = await startConsent(owner, account.workspace.id);
    expect(started.status).toBe(200);
    const authUrl = new URL(started.url);
    expect(`${authUrl.origin}${authUrl.pathname}`).toBe(`${mockBase}/authorize`);
    expect(authUrl.searchParams.get("client_id")).toBe("client-123.apps.googleusercontent.com");
    expect(authUrl.searchParams.get("redirect_uri")).toBe(
      `${env.PUBLIC_API_URL}/api/public/google/oauth/callback`,
    );
    expect(authUrl.searchParams.get("scope")).toContain(
      "https://www.googleapis.com/auth/drive.file",
    );
    expect(authUrl.searchParams.get("access_type")).toBe("offline");
    expect(authUrl.searchParams.get("prompt")).toBe("consent");
    const state = authUrl.searchParams.get("state") ?? "";
    expect(state.length).toBeGreaterThan(0);

    // 3. The callback exchanges the code, reads the account, and creates the Rupakarsa folder.
    const connected = await callback(owner, state);
    expect(connected.status).toBe(302);
    expect(connected.headers.get("location")).toBe(
      `${env.PUBLIC_CREATOR_URL}/app/workspaces?drive=connected`,
    );
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]?.grantType).toBe("authorization_code");
    expect(tokenCalls[0]?.code).toBe("ok");
    expect(userinfoCalls).toHaveLength(1);
    expect(folders).toEqual([{ id: "folder-1", name: "Rupakarsa" }]);

    const [row] = await db
      .select()
      .from(workspaceStorage)
      .where(eq(workspaceStorage.workspaceId, account.workspace.id));
    expect(row?.googleEmail).toBe("owner@example.test");
    expect(row?.folderId).toBe("folder-1");
    expect(row?.folderName).toBe("Rupakarsa");
    expect(row?.lastError).toBeNull();
    expect(row?.scope).toContain("drive.file");
    expect(row?.refreshTokenEncrypted.length).toBeGreaterThan(0);
    expect(row?.refreshTokenEncrypted).not.toContain("refresh-consent");
    expect(row?.accessTokenEncrypted).not.toContain("access-consent");

    // 4. The state nonce is single use: replaying it fails without a second token exchange.
    const replay = await callback(owner, state);
    expect(replay.status).toBe(302);
    expect(replay.headers.get("location")).toBe(
      `${env.PUBLIC_CREATOR_URL}/app/workspaces?drive=error`,
    );
    expect(tokenCalls).toHaveLength(1);
    expect(folders).toHaveLength(1);

    // 5. Status reports the connection plus the default storage the workspace would fall back to.
    const status = await owner.json<DriveStatusBody>(
      `/api/creator/workspaces/${account.workspace.id}/storage/drive`,
    );
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      connected: true,
      oauthConfigured: true,
      googleEmail: "owner@example.test",
      folderId: "folder-1",
      folderName: "Rupakarsa",
      defaultStorage: { kind: "local", retentionDays: 0 },
    });
    expect(status.body.folderUrl).toContain("folder-1");

    // 6. An upload lands in Drive under the folder, and /media streams it back through the driver.
    const form = new FormData();
    form.append("file", new File([PNG_BYTES], "frame.png", { type: "image/png" }));
    const uploaded = await owner.json<{ key: string; url: string }>("/api/creator/uploads", {
      method: "POST",
      body: form,
    });
    expect(uploaded.status).toBe(201);
    expect(uploads).toEqual([{ id: "file-1", name: "upload" }]);

    const [asset] = await db.select().from(mediaAssets).where(eq(mediaAssets.key, uploaded.body.key));
    expect(asset?.driver).toBe("gdrive");
    expect(asset?.externalId).toBe("file-1");

    const mediaPath = new URL(uploaded.body.url).pathname + new URL(uploaded.body.url).search;
    const media = await owner.request(mediaPath);
    expect(media.status).toBe(200);
    expect(Buffer.from(await media.arrayBuffer()).equals(PNG_BYTES)).toBe(true);

    // 7. Once the stored access token expires, the next call refreshes it with the refresh token.
    await db
      .update(workspaceStorage)
      .set({ accessTokenExpiresAt: new Date(Date.now() - 60_000) })
      .where(eq(workspaceStorage.workspaceId, account.workspace.id));
    // A live driver caches its token in memory; clear it so the stored value is read (as after a restart).
    clearStorageCache();
    const refreshedForm = new FormData();
    refreshedForm.append("file", new File([PNG_BYTES], "after-expiry.png", { type: "image/png" }));
    const refreshedUpload = await owner.json<{ key: string }>("/api/creator/uploads", {
      method: "POST",
      body: refreshedForm,
    });
    expect(refreshedUpload.status).toBe(201);
    const refreshCall = tokenCalls.at(-1);
    expect(refreshCall?.grantType).toBe("refresh_token");
    expect(refreshCall?.refreshToken).toBe("refresh-consent");
    expect(uploads).toHaveLength(2);
    const [refreshedRow] = await db
      .select()
      .from(workspaceStorage)
      .where(eq(workspaceStorage.workspaceId, account.workspace.id));
    expect(refreshedRow?.accessTokenEncrypted).not.toContain("access-refreshed");
    expect(refreshedRow?.lastError).toBeNull();

    // 8. Disconnecting revokes the token, and new uploads fall back to the global driver.
    const disconnected = await owner.request(
      `/api/creator/workspaces/${account.workspace.id}/storage/drive`,
      { method: "DELETE" },
    );
    expect(disconnected.status).toBe(204);
    expect(revoked).toEqual(["refresh-consent"]);
    const remaining = await db
      .select()
      .from(workspaceStorage)
      .where(eq(workspaceStorage.workspaceId, account.workspace.id));
    expect(remaining).toHaveLength(0);

    const secondForm = new FormData();
    secondForm.append("file", new File([PNG_BYTES], "second.png", { type: "image/png" }));
    const secondUpload = await owner.json<{ key: string }>("/api/creator/uploads", {
      method: "POST",
      body: secondForm,
    });
    expect(secondUpload.status).toBe(201);
    const [secondAsset] = await db
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.key, secondUpload.body.key));
    expect(secondAsset?.driver).toBe("local");
    expect(uploads).toHaveLength(2);
  });

  it("refuses consent when the actor lost admin rights and when a plain member starts", async () => {
    const account = await helpers.createAccount({ email: "member@example.test" });
    const admin = await adminClient();
    await saveStorageSettings(admin, {
      clientId: "client-123.apps.googleusercontent.com",
      clientSecret: "secret-123",
    });

    const member = helpers.createClient();
    await helpers.login(member, account.user.email);

    // A member without admin rights cannot start a connection.
    await db
      .update(workspaceMemberships)
      .set({ role: "MEMBER" })
      .where(eq(workspaceMemberships.workspaceId, account.workspace.id));
    const denied = await member.json<{ error: { code: string } }>(
      `/api/creator/workspaces/${account.workspace.id}/storage/drive/start`,
      { method: "POST" },
    );
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("FORBIDDEN");

    // Promoting back to admin lets the consent start, but a membership revoked before the callback
    // still aborts the exchange so no tokens are stored.
    await db
      .update(workspaceMemberships)
      .set({ role: "OWNER" })
      .where(eq(workspaceMemberships.workspaceId, account.workspace.id));
    const restart = await startConsent(member, account.workspace.id);
    expect(restart.status).toBe(200);
    const state = new URL(restart.url).searchParams.get("state") ?? "";

    await db
      .delete(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, account.workspace.id));
    tokenCalls.length = 0;
    const revokedMembership = await callback(member, state);
    expect(revokedMembership.status).toBe(302);
    expect(revokedMembership.headers.get("location")).toContain("drive=error");
    expect(tokenCalls).toHaveLength(0);
    const rows = await db
      .select()
      .from(workspaceStorage)
      .where(eq(workspaceStorage.workspaceId, account.workspace.id));
    expect(rows).toHaveLength(0);
  });

  it("survives an unreadable stored token and still disconnects", async () => {
    const account = await helpers.createAccount({ email: "rotated-key@example.test" });
    const owner = helpers.createClient();
    await helpers.login(owner, account.user.email);
    const admin = await adminClient();
    await saveStorageSettings(admin, {
      clientId: "client-123.apps.googleusercontent.com",
      clientSecret: "secret-123",
    });

    // A rotated APP_ENCRYPTION_KEY leaves ciphertext this process cannot read.
    await db.insert(workspaceStorage).values({
      workspaceId: account.workspace.id,
      googleEmail: "rotated@example.test",
      refreshTokenEncrypted: "v1:AAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBB:CCCC",
      accessTokenEncrypted: "v1:AAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBB:DDDD",
      accessTokenExpiresAt: new Date(Date.now() - 60_000),
      scope: "openid email https://www.googleapis.com/auth/drive.file",
      folderId: "folder-rotated",
      folderName: "Rupakarsa",
      connectedByUserId: account.user.id,
    });
    clearStorageCache();

    const tested = await owner.json<{ ok: boolean; message: string }>(
      `/api/creator/workspaces/${account.workspace.id}/storage/drive/test`,
      { method: "POST" },
    );
    expect(tested.status).toBe(200);
    expect(tested.body.ok).toBe(false);
    expect(tested.body.message).toBe(
      "Sesi Google Drive kedaluwarsa. Hubungkan ulang dari Kelola workspace.",
    );

    const disconnected = await owner.request(
      `/api/creator/workspaces/${account.workspace.id}/storage/drive`,
      { method: "DELETE" },
    );
    expect(disconnected.status).toBe(204);
    const remaining = await db
      .select()
      .from(workspaceStorage)
      .where(eq(workspaceStorage.workspaceId, account.workspace.id));
    expect(remaining).toHaveLength(0);
  });
});

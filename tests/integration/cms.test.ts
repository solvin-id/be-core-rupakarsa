import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "../../src/db/client.js";
import { aiModels, tokenLedger, users, workspaces } from "../../src/db/schema.js";
import { env } from "../../src/env.js";
import {
  addWorkspace,
  createAccount,
  createClient,
  jsonBody,
  login,
  modelByCode,
  resetDatabase,
} from "./helpers.js";
import type { TestClient } from "./helpers.js";

interface AccountBody {
  account: { id: string; email: string };
  temporaryPassword: string;
}

async function adminClient(): Promise<TestClient> {
  const client = createClient();
  await login(client, env.SEED_SUPERADMIN_EMAIL, env.SEED_SUPERADMIN_PASSWORD);
  return client;
}

describe("cms", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("creates an account with a temporary password that logs in", async () => {
    const client = await adminClient();

    const created = await client.json<AccountBody>(
      "/api/cms/accounts",
      jsonBody({
        fullName: "Bagas Aditya",
        email: "bagas@example.test",
        role: "USER",
        cmsAccess: false,
      }),
    );

    expect(created.status).toBe(201);
    expect(created.body.temporaryPassword).toHaveLength(16);

    const creator = createClient();
    const session = await login(creator, "bagas@example.test", created.body.temporaryPassword);
    expect(session.user.email).toBe("bagas@example.test");
    expect(session.workspace.name).toBe("Bagas Aditya Workspace");

    const duplicate = await client.json<{ error: { message: string } }>(
      "/api/cms/accounts",
      jsonBody({ fullName: "Bagas Lagi", email: "bagas@example.test", role: "USER", cmsAccess: false }),
    );
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.message).toBe("Email sudah terdaftar.");
  });

  it("forces CMS access for a superadmin", async () => {
    const client = await adminClient();
    const created = await client.json<AccountBody>(
      "/api/cms/accounts",
      jsonBody({ fullName: "Root Dua", email: "root2@example.test", role: "SUPERADMIN", cmsAccess: false }),
    );

    const [row] = await db.select().from(users).where(eq(users.id, created.body.account.id)).limit(1);
    expect(row?.cmsAccess).toBe(true);
  });

  it("refuses to deactivate the last active superadmin", async () => {
    const client = await adminClient();

    const me = await client.json<Array<{ id: string; email: string }>>("/api/cms/accounts");
    const superadmin = me.body.find((row) => row.email === env.SEED_SUPERADMIN_EMAIL);
    expect(superadmin).toBeDefined();

    const response = await client.json<{ error: { message: string } }>(
      `/api/cms/accounts/${superadmin?.id}`,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ isActive: false }) },
    );

    expect(response.status).toBe(409);
    expect(response.body.error.message).toBe("Minimal satu Superadmin harus aktif.");
  });

  it("rejects granting CMS access to a superadmin and deactivates sessions on deactivation", async () => {
    const client = await adminClient();
    const created = await client.json<AccountBody>(
      "/api/cms/accounts",
      jsonBody({ fullName: "Staf Baru", email: "staf@example.test", role: "USER", cmsAccess: false }),
    );

    const memberClient = createClient();
    await login(memberClient, "staf@example.test", created.body.temporaryPassword);

    const granted = await client.json<{ cmsAccess: boolean }>(
      `/api/cms/accounts/${created.body.account.id}`,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ cmsAccess: true }) },
    );
    expect(granted.status).toBe(200);
    expect(granted.body.cmsAccess).toBe(true);

    const deactivated = await client.json<{ isActive: boolean }>(
      `/api/cms/accounts/${created.body.account.id}`,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ isActive: false }) },
    );
    expect(deactivated.status).toBe(200);
    expect(deactivated.body.isActive).toBe(false);

    const blocked = await memberClient.json<{ error: { code: string } }>("/api/creator/session");
    expect(blocked.status).toBe(401);
  });

  it("tops up a workspace and records the ledger row", async () => {
    const client = await adminClient();
    const account = await createAccount({ email: "owner@example.test" });

    const topped = await client.json<{ tokenBalance: number; freePlanRemaining: number }>(
      `/api/cms/workspaces/${account.workspace.id}/topup`,
      jsonBody({ tokens: 500, plan: 10 }),
    );

    expect(topped.status).toBe(200);
    expect(topped.body.tokenBalance).toBe(500);
    expect(topped.body.freePlanRemaining).toBe(10);

    const ledger = await db.select().from(tokenLedger).where(eq(tokenLedger.workspaceId, account.workspace.id));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.txType).toBe("TOPUP");
    expect(ledger[0]?.amount).toBe(500);

    const invalid = await client.json<{ error: { message: string } }>(
      `/api/cms/workspaces/${account.workspace.id}/topup`,
      jsonBody({ tokens: 0, plan: 0 }),
    );
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.message).toBe("Jumlah token harus lebih dari 0.");
  });

  it("creates workspaces for an owner and lists memberships with user summaries", async () => {
    const client = await adminClient();
    const account = await createAccount({ email: "owner@example.test", fullName: "Owner Satu" });

    const created = await client.json<{ id: string; slug: string }>(
      "/api/cms/workspaces",
      jsonBody({
        name: "Lumiere Lab",
        slug: "lumiere-lab",
        ownerId: account.user.id,
        tokenBalance: 1200,
        freePlanRemaining: 50,
      }),
    );
    expect(created.status).toBe(201);
    expect(created.body.slug).toBe("lumiere-lab");

    const duplicate = await client.json<{ error: { message: string } }>(
      "/api/cms/workspaces",
      jsonBody({ name: "Lumiere Dua", slug: "lumiere-lab", ownerId: account.user.id }),
    );
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.message).toBe("Slug workspace sudah dipakai.");

    const listed = await client.json<{
      workspaces: Array<{ id: string }>;
      memberships: Array<{ user: { fullName: string }; role: string }>;
    }>("/api/cms/workspaces");
    expect(listed.status).toBe(200);
    expect(listed.body.memberships.some((row) => row.user.fullName === "Owner Satu")).toBe(true);
    expect(listed.body.memberships.some((row) => row.role === "OWNER")).toBe(true);
  });

  it("patches a workspace without touching balances", async () => {
    const client = await adminClient();
    const account = await createAccount({ email: "owner@example.test" });
    await db.update(workspaces).set({ tokenBalance: 77 }).where(eq(workspaces.id, account.workspace.id));

    const patched = await client.json<{ name: string; isActive: boolean; tokenBalance: number }>(
      `/api/cms/workspaces/${account.workspace.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Diubah", isActive: false }),
      },
    );

    expect(patched.status).toBe(200);
    expect(patched.body.name).toBe("Diubah");
    expect(patched.body.isActive).toBe(false);
    expect(patched.body.tokenBalance).toBe(77);
  });

  it("never returns the raw provider key and re-masks on update", async () => {
    const client = await adminClient();
    const providers = await client.json<Array<{ id: string; code: string }>>("/api/cms/providers");
    const higgsfield = providers.body.find((row) => row.code === "HIGGSFIELD");
    expect(higgsfield).toBeDefined();

    const updated = await client.json<{ apiKeyMasked: string }>(
      `/api/cms/providers/${higgsfield?.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: "hf-live-abc123" }),
      },
    );
    expect(updated.status).toBe(200);
    expect(JSON.stringify(updated.body)).not.toContain("hf-live-abc123");
    expect(updated.body.apiKeyMasked).toBe("hf-••••••••c123");

    const remasked = await client.json<{ apiKeyMasked: string }>(
      `/api/cms/providers/${higgsfield?.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: "hf-live-zzz999" }),
      },
    );
    expect(remasked.body.apiKeyMasked).toBe("hf-••••••••z999");

    const duplicate = await client.json<{ error: { message: string } }>(
      "/api/cms/providers",
      jsonBody({
        name: "Duplikat",
        code: "higgsfield",
        baseUrl: "https://x.test",
        apiKey: "hf-live-abc123",
        isActive: true,
      }),
    );
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.message).toBe("Kode provider sudah dipakai.");

    const created = await client.json<{ id: string; code: string; apiKeyMasked: string }>(
      "/api/cms/providers",
      jsonBody({
        name: "Virtual Try-On",
        code: "virtual-tryon",
        baseUrl: "https://tryon.test",
        apiKey: "vt-live-abc123",
        isActive: true,
      }),
    );
    expect(created.status).toBe(201);
    expect(created.body.code).toBe("VIRTUAL-TRYON");
    expect(created.body.apiKeyMasked).toBe("vt-••••••••c123");

    const tested = await client.json<{ ok: boolean; message: string }>(
      `/api/cms/providers/${higgsfield?.id}/test`,
      { method: "POST" },
    );
    expect(tested.status).toBe(200);
    expect(tested.body.ok).toBe(true);
    expect(tested.body.message).toContain("mode simulasi");
  });

  it("rejects a provider key shorter than six characters", async () => {
    const client = await adminClient();
    const response = await client.json<{ error: { message: string } }>(
      "/api/cms/providers",
      jsonBody({
        name: "Pendek",
        code: "pendek",
        baseUrl: "https://x.test",
        apiKey: "12345",
        isActive: true,
      }),
    );
    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe("API key minimal 6 karakter.");
  });

  it("creates models, rejects duplicates per provider, and patches the tariff", async () => {
    const client = await adminClient();
    const providers = await client.json<Array<{ id: string; code: string }>>("/api/cms/providers");
    const provider = providers.body.find((row) => row.code === "HIGGSFIELD");
    expect(provider).toBeDefined();
    const model = await modelByCode("flux-image");

    const duplicate = await client.json<{ error: { message: string } }>(
      "/api/cms/models",
      jsonBody({
        providerId: provider?.id,
        code: "flux-image",
        displayName: "Flux Duplikat",
        mediaType: "IMAGE",
        allowedParams: { resolutions: ["1k"], aspectRatios: ["1:1"] },
        tokenCost: 2,
        isActive: true,
      }),
    );
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.message).toBe("Kode model sudah dipakai untuk provider ini.");

    const created = await client.json<{ id: string; code: string; tokenCost: number }>(
      "/api/cms/models",
      jsonBody({
        providerId: provider?.id,
        code: "Flux-New",
        displayName: "Flux New",
        mediaType: "IMAGE",
        allowedParams: { resolutions: ["1k", "2k"], aspectRatios: ["1:1", "16:9"] },
        tokenCost: 3,
        isActive: true,
      }),
    );
    expect(created.status).toBe(201);
    expect(created.body.code).toBe("flux-new");

    const emptyParams = await client.json<{ error: { message: string } }>(
      "/api/cms/models",
      jsonBody({
        providerId: provider?.id,
        code: "kosong",
        displayName: "Kosong",
        mediaType: "IMAGE",
        allowedParams: { resolutions: [], aspectRatios: ["1:1"] },
        tokenCost: 1,
        isActive: true,
      }),
    );
    expect(emptyParams.status).toBe(400);
    expect(emptyParams.body.error.message).toBe("Resolusi dan rasio aspek tidak boleh kosong.");

    const patched = await client.json<{ tokenCost: number; isActive: boolean }>(
      `/api/cms/models/${model.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tokenCost: 9, isActive: false }),
      },
    );
    expect(patched.status).toBe(200);
    expect(patched.body.tokenCost).toBe(9);
    expect(patched.body.isActive).toBe(false);

    const negative = await client.json<{ error: { message: string } }>(
      `/api/cms/models/${model.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tokenCost: -1 }),
      },
    );
    expect(negative.status).toBe(400);
    expect(negative.body.error.message).toBe("Tarif token harus angka 0 atau lebih.");

    const rows = await db.select().from(aiModels);
    expect(rows.some((row) => row.code === "flux-new")).toBe(true);
  });

  it("serves model templates filtered by provider code", async () => {
    const client = await adminClient();

    const all = await client.json<Array<{ providerCode: string; tokenCost: number }>>(
      "/api/cms/model-templates",
    );
    expect(all.status).toBe(200);
    expect(all.body).toHaveLength(9);

    const filtered = await client.json<Array<{ providerCode: string }>>(
      "/api/cms/model-templates?providerCode=kenari_ai",
    );
    expect(filtered.status).toBe(200);
    expect(filtered.body).toHaveLength(0);
  });

  it("assigns a new account to existing workspaces instead of creating a personal one", async () => {
    const client = await adminClient();
    const owner = await createAccount({ email: "ops@example.test", fullName: "Ops Satu" });

    const extra = await client.json<{ id: string }>(
      "/api/cms/workspaces",
      jsonBody({ name: "Klinik B2B", slug: "klinik-b2b", ownerId: owner.user.id }),
    );
    expect(extra.status).toBe(201);

    const before = await db.select({ id: workspaces.id }).from(workspaces);

    const created = await client.json<AccountBody>(
      "/api/cms/accounts",
      jsonBody({
        fullName: "B2B Satu",
        email: "b2b@example.test",
        role: "USER",
        cmsAccess: false,
        workspaceMode: "EXISTING",
        workspaceIds: [extra.body.id, owner.workspace.id],
      }),
    );
    expect(created.status).toBe(201);

    const after = await db.select({ id: workspaces.id }).from(workspaces);
    expect(after).toHaveLength(before.length);

    const creator = createClient();
    const session = await creator.json<{
      workspace: { id: string };
      workspaces: Array<{ id: string }>;
      memberships: Array<{ workspaceId: string; role: string }>;
      activeWorkspaceRole: string;
    }>("/api/creator/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "b2b@example.test",
        password: created.body.temporaryPassword,
      }),
    });

    expect(session.status).toBe(200);
    expect(session.body.workspace.id).toBe(extra.body.id);
    expect(session.body.workspaces).toHaveLength(2);
    expect(session.body.memberships).toHaveLength(2);
    expect(session.body.activeWorkspaceRole).toBe("MEMBER");
    expect(session.body.memberships.every((row) => row.role === "MEMBER")).toBe(true);
  });

  it("rejects invalid workspace assignment payloads", async () => {
    const client = await adminClient();
    const base = {
      fullName: "B2B Salah",
      email: "b2b-salah@example.test",
      role: "USER",
      cmsAccess: false,
    };

    const personal = await client.json<{ error: { message: string } }>(
      "/api/cms/accounts",
      jsonBody({ ...base, workspaceMode: "PERSONAL", workspaceIds: [randomUUID()] }),
    );
    expect(personal.status).toBe(400);
    expect(personal.body.error.message).toBe("Mode personal tidak menerima daftar workspace.");

    const empty = await client.json<{ error: { message: string } }>(
      "/api/cms/accounts",
      jsonBody({ ...base, workspaceMode: "EXISTING", workspaceIds: [] }),
    );
    expect(empty.status).toBe(400);
    expect(empty.body.error.message).toBe("Pilih minimal satu workspace untuk akun ini.");

    const missing = await client.json<{ error: { message: string } }>(
      "/api/cms/accounts",
      jsonBody({ ...base, workspaceMode: "EXISTING", workspaceIds: [randomUUID()] }),
    );
    expect(missing.status).toBe(404);
    expect(missing.body.error.message).toBe("Workspace tidak ditemukan.");

    const owner = await createAccount({ email: "ops-off@example.test" });
    const inactive = await addWorkspace(owner.user.id, {
      name: "Nonaktif",
      role: "OWNER",
      isActive: false,
    });
    const off = await client.json<{ error: { message: string } }>(
      "/api/cms/accounts",
      jsonBody({ ...base, workspaceMode: "EXISTING", workspaceIds: [inactive.id] }),
    );
    expect(off.status).toBe(400);
    expect(off.body.error.message).toBe("Workspace tidak aktif.");
  });

  it("adds and removes account memberships without stranding the account", async () => {
    const client = await adminClient();
    const owner = await createAccount({ email: "ops@example.test", fullName: "Ops Satu" });
    const extra = await addWorkspace(owner.user.id, { name: "Workspace C", role: "OWNER" });
    const target = await createAccount({ email: "anggota@example.test" });

    const added = await client.json<Array<{ workspaceId: string; role: string }>>(
      `/api/cms/accounts/${target.user.id}/workspaces`,
      jsonBody({ workspaceIds: [extra.id] }),
    );
    expect(added.status).toBe(200);
    expect(added.body).toHaveLength(2);
    expect(added.body.map((row) => row.workspaceId).sort()).toEqual(
      [target.workspace.id, extra.id].sort(),
    );

    const repeated = await client.json<Array<{ workspaceId: string }>>(
      `/api/cms/accounts/${target.user.id}/workspaces`,
      jsonBody({ workspaceIds: [extra.id, extra.id] }),
    );
    expect(repeated.status).toBe(200);
    expect(repeated.body).toHaveLength(2);

    const detached = await client.json<undefined>(
      `/api/cms/accounts/${target.user.id}/workspaces/${target.workspace.id}`,
      { method: "DELETE" },
    );
    expect(detached.status).toBe(204);

    const [relocated] = await db.select().from(users).where(eq(users.id, target.user.id)).limit(1);
    expect(relocated?.defaultWorkspaceId).toBe(extra.id);

    const stranded = await client.json<{ error: { message: string } }>(
      `/api/cms/accounts/${target.user.id}/workspaces/${extra.id}`,
      { method: "DELETE" },
    );
    expect(stranded.status).toBe(409);
    expect(stranded.body.error.message).toBe("Setiap akun harus punya minimal satu workspace.");

    const notMember = await client.json<{ error: { message: string } }>(
      `/api/cms/accounts/${target.user.id}/workspaces/${owner.workspace.id}`,
      { method: "DELETE" },
    );
    expect(notMember.status).toBe(404);
    expect(notMember.body.error.message).toBe("Akun bukan anggota workspace tersebut.");

    const badDefault = await client.json<{ error: { message: string } }>(
      `/api/cms/accounts/${target.user.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ defaultWorkspaceId: owner.workspace.id }),
      },
    );
    expect(badDefault.status).toBe(400);
    expect(badDefault.body.error.message).toBe("Akun bukan anggota workspace tersebut.");

    const movedDefault = await client.json<{ defaultWorkspaceId: string }>(
      `/api/cms/accounts/${owner.user.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ defaultWorkspaceId: extra.id }),
      },
    );
    expect(movedDefault.status).toBe(200);
    expect(movedDefault.body.defaultWorkspaceId).toBe(extra.id);
  });

  it("blocks creators without CMS access from managing account workspaces", async () => {
    const client = await adminClient();
    const target = await createAccount({ email: "anggota@example.test" });

    const creator = createClient();
    await login(creator, "anggota@example.test");

    const response = await creator.json<{ error: { code: string } }>(
      `/api/cms/accounts/${target.user.id}/workspaces`,
      jsonBody({ workspaceIds: [target.workspace.id] }),
    );
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("validates the admin contact before saving it", async () => {
    const client = await adminClient();

    const rejected = await client.json<{ error: { message: string } }>("/api/cms/settings/contact", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Tim Rupakarsa", whatsapp: "123", email: "halo@rupakarsa.id" }),
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.message).toBe("Nomor WhatsApp harus 8–15 digit, contoh 6281234567890.");

    const saved = await client.json<{ whatsapp: string }>("/api/cms/settings/contact", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Tim Rupakarsa",
        whatsapp: "+62 812-3456-7890",
        email: "halo@rupakarsa.id",
      }),
    });
    expect(saved.status).toBe(200);
    expect(saved.body.whatsapp).toBe("6281234567890");

    const fetched = await client.json<{ whatsapp: string }>("/api/cms/settings/contact");
    expect(fetched.body.whatsapp).toBe("6281234567890");
  });
});

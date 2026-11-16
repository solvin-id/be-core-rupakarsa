import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "../../src/db/client.js";
import { users, workspaceJoinRequests, workspaces } from "../../src/db/schema.js";
import {
  addMember,
  addWorkspace,
  activateWorkspace,
  createAccount,
  createClient,
  createFolder,
  jsonBody,
  login,
  resetDatabase,
} from "./helpers.js";

interface SessionBody {
  workspace: { id: string; name: string; tokenBalance: number };
  activeWorkspaceRole: string;
  memberships: unknown[];
}

async function defaultWorkspaceIdOf(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ defaultWorkspaceId: users.defaultWorkspaceId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.defaultWorkspaceId ?? null;
}

describe("creator workspaces", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("creates a workspace with an auto slug and rejects a duplicate explicit slug", async () => {
    await createAccount({ email: "owner@example.test" });
    const client = createClient();
    await login(client, "owner@example.test");

    const created = await client.json<{ id: string; slug: string; name: string }>(
      "/api/creator/workspaces",
      jsonBody({ name: "Test Lab" }),
    );
    expect(created.status).toBe(201);
    expect(created.body.slug).toBe("test-lab");
    expect(created.body.name).toBe("Test Lab");

    const second = await client.json<{ slug: string }>(
      "/api/creator/workspaces",
      jsonBody({ name: "Test Lab" }),
    );
    expect(second.status).toBe(201);
    expect(second.body.slug).toBe("test-lab-2");

    const duplicate = await client.json<{ error: { message: string } }>(
      "/api/creator/workspaces",
      jsonBody({ name: "Another", slug: "test-lab" }),
    );
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.message).toBe("Slug workspace sudah dipakai.");

    const tooShort = await client.json<{ error: { message: string } }>(
      "/api/creator/workspaces",
      jsonBody({ name: "A" }),
    );
    expect(tooShort.status).toBe(400);
    expect(tooShort.body.error.message).toBe("Nama workspace minimal 2 karakter.");
  });

  it("activates a workspace the caller belongs to", async () => {
    const account = await createAccount({ email: "owner@example.test" });
    const other = await addWorkspace(account.user.id, { name: "Kedua", role: "MEMBER" });
    const client = createClient();
    await login(client, "owner@example.test");

    const activated = await client.json<SessionBody>(
      `/api/creator/workspaces/${other.id}/activate`,
      { method: "POST" },
    );
    expect(activated.status).toBe(200);
    expect(activated.body.workspace.id).toBe(other.id);

    const session = await client.json<SessionBody>("/api/creator/session");
    expect(session.body.workspace.id).toBe(other.id);
  });

  it("refuses to activate a workspace the caller does not belong to", async () => {
    await createAccount({ email: "owner@example.test" });
    const stranger = await createAccount({ email: "stranger@example.test" });
    const client = createClient();
    await login(client, "owner@example.test");

    const response = await client.json<{ error: { message: string } }>(
      `/api/creator/workspaces/${stranger.workspace.id}/activate`,
      { method: "POST" },
    );
    expect(response.status).toBe(403);
    expect(response.body.error.message).toBe("Anda bukan anggota workspace ini.");
  });

  it("restricts renaming to the owner", async () => {
    const account = await createAccount({ email: "owner@example.test" });
    const admin = await createAccount({ email: "admin@example.test" });
    await addMember(account.workspace.id, admin.user.id, "ADMIN");

    const adminClient = createClient();
    await login(adminClient, "admin@example.test");
    await activateWorkspace(adminClient, account.workspace.id);

    const denied = await adminClient.json<{ error: { message: string } }>(
      `/api/creator/workspaces/${account.workspace.id}`,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Baru" }) },
    );
    expect(denied.status).toBe(403);
    expect(denied.body.error.message).toBe("Hanya owner yang dapat mengubah nama workspace.");

    const ownerClient = createClient();
    await login(ownerClient, "owner@example.test");
    const renamed = await ownerClient.json<{ name: string }>(
      `/api/creator/workspaces/${account.workspace.id}`,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Studio Baru" }) },
    );
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe("Studio Baru");
  });

  it("guards leaving a workspace", async () => {
    const account = await createAccount({ email: "owner@example.test" });
    const member = await createAccount({ email: "member@example.test" });
    await addMember(account.workspace.id, member.user.id, "MEMBER");

    const ownerClient = createClient();
    await login(ownerClient, "owner@example.test");
    const ownerLeave = await ownerClient.json<{ error: { message: string } }>(
      `/api/creator/workspaces/${account.workspace.id}/leave`,
      { method: "POST" },
    );
    expect(ownerLeave.status).toBe(403);
    expect(ownerLeave.body.error.message).toBe(
      "Owner tidak dapat keluar. Hapus workspace bila tidak dipakai.",
    );

    // Drop the member's personal workspace so the shared workspace is their only membership.
    await db.delete(workspaces).where(eq(workspaces.id, member.workspace.id));

    const memberClient = createClient();
    await login(memberClient, "member@example.test");
    await activateWorkspace(memberClient, account.workspace.id);
    const soleLeave = await memberClient.json<{ error: { message: string } }>(
      `/api/creator/workspaces/${account.workspace.id}/leave`,
      { method: "POST" },
    );
    expect(soleLeave.status).toBe(409);
    expect(soleLeave.body.error.message).toBe("Setiap akun harus punya minimal satu workspace.");
  });

  it("leaves a second workspace and relocates the default workspace", async () => {
    const account = await createAccount({ email: "member@example.test" });
    const extra = await addWorkspace(account.user.id, { name: "Extra", role: "MEMBER" });
    await db.update(users).set({ defaultWorkspaceId: extra.id }).where(eq(users.id, account.user.id));

    const client = createClient();
    await login(client, "member@example.test");
    await activateWorkspace(client, extra.id);

    const left = await client.request(`/api/creator/workspaces/${extra.id}/leave`, { method: "POST" });
    expect(left.status).toBe(204);
    expect(await defaultWorkspaceIdOf(account.user.id)).toBe(account.workspace.id);
  });

  it("restricts role changes to the owner and protects the owner role", async () => {
    const owner = await createAccount({ email: "owner@example.test" });
    const admin = await createAccount({ email: "admin@example.test" });
    const member = await createAccount({ email: "member@example.test" });
    await addMember(owner.workspace.id, admin.user.id, "ADMIN");
    await addMember(owner.workspace.id, member.user.id, "MEMBER");

    const adminClient = createClient();
    await login(adminClient, "admin@example.test");
    await activateWorkspace(adminClient, owner.workspace.id);
    const denied = await adminClient.json<{ error: { message: string } }>(
      `/api/creator/workspaces/${owner.workspace.id}/members/${member.user.id}`,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: "ADMIN" }) },
    );
    expect(denied.status).toBe(403);
    expect(denied.body.error.message).toBe("Hanya owner yang dapat mengubah role anggota.");

    const ownerClient = createClient();
    await login(ownerClient, "owner@example.test");
    const promoted = await ownerClient.json<{ role: string }>(
      `/api/creator/workspaces/${owner.workspace.id}/members/${member.user.id}`,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: "ADMIN" }) },
    );
    expect(promoted.status).toBe(200);
    expect(promoted.body.role).toBe("ADMIN");

    const protectOwner = await ownerClient.json<{ error: { message: string } }>(
      `/api/creator/workspaces/${owner.workspace.id}/members/${owner.user.id}`,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: "MEMBER" }) },
    );
    expect(protectOwner.status).toBe(403);
    expect(protectOwner.body.error.message).toBe("Role owner tidak dapat diubah.");
  });

  it("applies every member removal rule", async () => {
    const owner = await createAccount({ email: "owner@example.test" });
    const admin = await createAccount({ email: "admin@example.test" });
    const secondAdmin = await createAccount({ email: "admin2@example.test" });
    const member = await createAccount({ email: "member@example.test" });
    const loner = await createAccount({ email: "loner@example.test" });

    await addMember(owner.workspace.id, admin.user.id, "ADMIN");
    await addMember(owner.workspace.id, secondAdmin.user.id, "ADMIN");
    await addMember(owner.workspace.id, member.user.id, "MEMBER");
    await addMember(owner.workspace.id, loner.user.id, "MEMBER");

    // The loner must hold exactly one membership for the stranded guard to fire.
    await db.delete(workspaces).where(eq(workspaces.id, loner.workspace.id));

    const adminClient = createClient();
    await login(adminClient, "admin@example.test");
    await activateWorkspace(adminClient, owner.workspace.id);

    const adminOnAdmin = await adminClient.json<{ error: { message: string } }>(
      `/api/creator/workspaces/${owner.workspace.id}/members/${secondAdmin.user.id}`,
      { method: "DELETE" },
    );
    expect(adminOnAdmin.status).toBe(403);
    expect(adminOnAdmin.body.error.message).toBe("Admin tidak dapat mengeluarkan admin lain.");

    const selfRemoval = await adminClient.json<{ error: { message: string } }>(
      `/api/creator/workspaces/${owner.workspace.id}/members/${admin.user.id}`,
      { method: "DELETE" },
    );
    expect(selfRemoval.status).toBe(403);
    // An admin is also an admin, so that rule fires before the self-removal hint.
    expect(selfRemoval.body.error.message).toBe("Admin tidak dapat mengeluarkan admin lain.");

    const ownerRemoval = await adminClient.json<{ error: { message: string } }>(
      `/api/creator/workspaces/${owner.workspace.id}/members/${owner.user.id}`,
      { method: "DELETE" },
    );
    expect(ownerRemoval.status).toBe(403);
    expect(ownerRemoval.body.error.message).toBe("Owner tidak dapat dikeluarkan dari workspace.");

    const stranded = await adminClient.json<{ error: { message: string } }>(
      `/api/creator/workspaces/${owner.workspace.id}/members/${loner.user.id}`,
      { method: "DELETE" },
    );
    expect(stranded.status).toBe(409);
    expect(stranded.body.error.message).toBe("Test User hanya tergabung di workspace ini.");

    await addWorkspace(member.user.id, { name: "Member Kedua", role: "MEMBER" });
    await db
      .update(users)
      .set({ defaultWorkspaceId: owner.workspace.id })
      .where(eq(users.id, member.user.id));

    const removed = await adminClient.request(
      `/api/creator/workspaces/${owner.workspace.id}/members/${member.user.id}`,
      { method: "DELETE" },
    );
    expect(removed.status).toBe(204);

    const remaining = await defaultWorkspaceIdOf(member.user.id);
    expect(remaining).not.toBe(owner.workspace.id);
    expect(remaining).not.toBeNull();
  });

  it("lists members with user summaries for members of the workspace", async () => {
    const owner = await createAccount({ email: "owner@example.test", fullName: "Owner Satu" });
    const member = await createAccount({ email: "member@example.test", fullName: "Member Dua" });
    await addMember(owner.workspace.id, member.user.id, "MEMBER");

    const client = createClient();
    await login(client, "member@example.test");
    await activateWorkspace(client, owner.workspace.id);

    const response = await client.json<Array<{ user: { fullName: string; email: string } }>>(
      `/api/creator/workspaces/${owner.workspace.id}/members`,
    );
    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(2);
    expect(response.body.map((row) => row.user.fullName).sort()).toEqual(["Member Dua", "Owner Satu"]);
  });

  it("blocks deleting a workspace that would strand a member, then cascades", async () => {
    const owner = await createAccount({ email: "owner@example.test" });
    const member = await createAccount({ email: "member@example.test" });
    await addMember(owner.workspace.id, member.user.id, "MEMBER");

    const client = createClient();
    await login(client, "owner@example.test");

    const blocked = await client.json<{ error: { message: string } }>(
      `/api/creator/workspaces/${owner.workspace.id}`,
      { method: "DELETE" },
    );
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toContain("hanya tergabung di");

    const other = await addWorkspace(member.user.id, { name: "Penyelamat", role: "MEMBER" });
    const backup = await addWorkspace(owner.user.id, { name: "Cadangan", role: "MEMBER" });
    await db
      .update(users)
      .set({ defaultWorkspaceId: owner.workspace.id })
      .where(eq(users.id, member.user.id));

    const folder = await createFolder(client, "Folder Dihapus");
    const deleted = await client.request(`/api/creator/workspaces/${owner.workspace.id}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(204);

    const [workspaceRow] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, owner.workspace.id));
    expect(workspaceRow).toBeUndefined();
    const relocated = await defaultWorkspaceIdOf(member.user.id);
    expect([member.workspace.id, other.id]).toContain(relocated);

    const session = await client.json<SessionBody>("/api/creator/session");
    expect(session.status).toBe(200);
    expect(session.body.workspace.id).toBe(backup.id);
    expect(folder.id).toBeDefined();
  });

  it("handles join requests end to end", async () => {
    const owner = await createAccount({ email: "owner@example.test", workspaceName: "Lumiere Lab" });
    const outsider = await createAccount({ email: "outsider@example.test" });
    const slug = (
      await db
        .select({ slug: workspaces.slug })
        .from(workspaces)
        .where(eq(workspaces.id, owner.workspace.id))
        .limit(1)
    )[0]?.slug;
    expect(slug).toBeDefined();

    const outsiderClient = createClient();
    await login(outsiderClient, "outsider@example.test");

    const created = await outsiderClient.json<{ status: string }>(
      "/api/creator/join-requests",
      jsonBody({ slug, message: "Mohon bergabung" }),
    );
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("PENDING");

    const duplicate = await outsiderClient.json<{ error: { message: string } }>(
      "/api/creator/join-requests",
      jsonBody({ slug }),
    );
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.message).toBe("Permintaan Anda masih menunggu persetujuan.");

    const unknown = await outsiderClient.json<{ error: { message: string } }>(
      "/api/creator/join-requests",
      jsonBody({ slug: "tidak-ada" }),
    );
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.message).toBe("Workspace dengan slug tersebut tidak ditemukan.");

    const [pending] = await db
      .select()
      .from(workspaceJoinRequests)
      .where(eq(workspaceJoinRequests.workspaceId, owner.workspace.id))
      .limit(1);
    expect(pending).toBeDefined();

    const ownerClient = createClient();
    await login(ownerClient, "owner@example.test");
    const approved = await ownerClient.request(
      `/api/creator/join-requests/${pending?.id}/approve`,
      { method: "POST" },
    );
    expect(approved.status).toBe(204);

    const again = await ownerClient.json<{ error: { message: string } }>(
      `/api/creator/join-requests/${pending?.id}/approve`,
      { method: "POST" },
    );
    expect(again.status).toBe(409);
    expect(again.body.error.message).toBe("Permintaan sudah diproses.");

    const members = await ownerClient.json<Array<{ userId: string; role: string }>>(
      `/api/creator/workspaces/${owner.workspace.id}/members`,
    );
    expect(members.body.some((row) => row.userId === outsider.user.id && row.role === "MEMBER")).toBe(true);

    const removed = await ownerClient.request(
      `/api/creator/workspaces/${owner.workspace.id}/members/${outsider.user.id}`,
      { method: "DELETE" },
    );
    expect(removed.status).toBe(204);

    const outsiderRequests = await outsiderClient.json<{ myRequests: unknown[] }>(
      "/api/creator/workspaces",
    );
    expect(outsiderRequests.status).toBe(200);
    expect(outsiderRequests.body.myRequests).toHaveLength(1);
  });

  it("rejects a join request for an inactive workspace", async () => {
    const owner = await createAccount({ email: "owner@example.test" });
    await db.update(workspaces).set({ isActive: false }).where(eq(workspaces.id, owner.workspace.id));
    const slug = (
      await db
        .select({ slug: workspaces.slug })
        .from(workspaces)
        .where(eq(workspaces.id, owner.workspace.id))
        .limit(1)
    )[0]?.slug;

    const outsider = await createAccount({ email: "outsider@example.test" });
    const client = createClient();
    await login(client, "outsider@example.test");

    const response = await client.json<{ error: { message: string } }>(
      "/api/creator/join-requests",
      jsonBody({ slug }),
    );
    expect(response.status).toBe(409);
    expect(response.body.error.message).toBe("Workspace ini sedang tidak aktif.");
    void outsider;
  });

  it("rejects a join request when the caller is already a member", async () => {
    const owner = await createAccount({ email: "owner@example.test" });
    const slug = (
      await db
        .select({ slug: workspaces.slug })
        .from(workspaces)
        .where(eq(workspaces.id, owner.workspace.id))
        .limit(1)
    )[0]?.slug;

    const client = createClient();
    await login(client, "owner@example.test");

    const response = await client.json<{ error: { message: string } }>(
      "/api/creator/join-requests",
      jsonBody({ slug }),
    );
    expect(response.status).toBe(409);
    expect(response.body.error.message).toBe("Anda sudah menjadi anggota workspace ini.");
  });

  it("rejects a join request as a non-manager and processes it as a manager", async () => {
    const owner = await createAccount({ email: "owner@example.test" });
    const outsider = await createAccount({ email: "outsider@example.test" });
    const plainMember = await createAccount({ email: "plain@example.test" });
    await addMember(owner.workspace.id, plainMember.user.id, "MEMBER");

    const slug = (
      await db
        .select({ slug: workspaces.slug })
        .from(workspaces)
        .where(eq(workspaces.id, owner.workspace.id))
        .limit(1)
    )[0]?.slug;

    const outsiderClient = createClient();
    await login(outsiderClient, "outsider@example.test");
    await outsiderClient.json("/api/creator/join-requests", jsonBody({ slug }));

    const [request] = await db
      .select()
      .from(workspaceJoinRequests)
      .where(eq(workspaceJoinRequests.workspaceId, owner.workspace.id))
      .limit(1);

    const plainClient = createClient();
    await login(plainClient, "plain@example.test");
    await activateWorkspace(plainClient, owner.workspace.id);
    const denied = await plainClient.json<{ error: { message: string } }>(
      `/api/creator/join-requests/${request?.id}/reject`,
      { method: "POST" },
    );
    expect(denied.status).toBe(403);
    expect(denied.body.error.message).toBe("Hanya owner atau admin yang dapat menolak permintaan.");

    const ownerClient = createClient();
    await login(ownerClient, "owner@example.test");
    const rejected = await ownerClient.request(`/api/creator/join-requests/${request?.id}/reject`, {
      method: "POST",
    });
    expect(rejected.status).toBe(204);

    const payload = await ownerClient.json<{ manageableRequests: unknown[] }>("/api/creator/workspaces");
    expect(payload.body.manageableRequests).toHaveLength(0);
    void outsider;
  });
});

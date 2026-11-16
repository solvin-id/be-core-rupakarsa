import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "../../src/db/client.js";
import { mediaAssets, workspaces } from "../../src/db/schema.js";
import { env } from "../../src/env.js";
import { SETTING_KEYS, readSetting, getStorageSettings } from "../../src/services/settings.js";
import { purgeExpiredMedia, resolveStorage } from "../../src/services/storage-service.js";
import {
  activateWorkspace,
  addMember,
  createAccount,
  createClient,
  jsonBody,
  login,
  resetDatabase,
} from "./helpers.js";
import type { TestClient } from "./helpers.js";

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

interface StorageItemBody {
  id: string;
  key: string;
  name: string;
  mime: string;
  source: string;
  url: string;
  driver: string;
  generationId: string | null;
  purgedAt: string | null;
}

async function uploadPng(client: TestClient, name = "frame.png"): Promise<{ key: string; url: string }> {
  const form = new FormData();
  form.append("file", new File([PNG_BYTES], name, { type: "image/png" }));
  const uploaded = await client.json<{ key: string; url: string }>("/api/creator/uploads", {
    method: "POST",
    body: form,
  });
  if (uploaded.status !== 201) throw new Error(`upload failed: ${JSON.stringify(uploaded.body)}`);
  return uploaded.body;
}

async function insertVideoAsset(workspaceId: string): Promise<{ id: string; key: string }> {
  const storage = await resolveStorage(workspaceId);
  const key = `workspaces/${workspaceId}/generations/${randomUUID()}.mp4`;
  const bytes = Buffer.from([0x00, 0x00, 0x00, 0x18]);
  await storage.driver.put(key, bytes, "video/mp4");
  const [row] = await db
    .insert(mediaAssets)
    .values({
      workspaceId,
      key,
      mime: "video/mp4",
      size: bytes.byteLength,
      driver: storage.kind,
      durationMs: 5000,
    })
    .returning();
  if (!row) throw new Error("failed to insert the video asset");
  return { id: row.id, key };
}

async function adminClient(): Promise<TestClient> {
  const client = createClient();
  await login(client, env.SEED_SUPERADMIN_EMAIL, env.SEED_SUPERADMIN_PASSWORD);
  return client;
}

describe("storage", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("stores the global driver settings and keeps the retention window", async () => {
    const admin = await adminClient();

    const saved = await admin.json<{ driver: string; retentionDays: number }>(
      "/api/cms/settings/storage",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          driver: "local",
          retentionDays: 3,
          s3: {
            endpoint: "",
            region: "auto",
            bucket: "",
            accessKeyId: "",
            publicBaseUrl: "",
            forcePathStyle: true,
          },
        }),
      },
    );
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ driver: "local", retentionDays: 3 });

    const stored = await readSetting(db, SETTING_KEYS.storage, { retentionDays: 0 });
    expect(stored).toMatchObject({ driver: "local", retentionDays: 3 });

    const settings = await getStorageSettings(db);
    expect(settings.driver).toBe("local");

    const badS3 = await admin.json<{ error: { message: string } }>("/api/cms/settings/storage", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        driver: "s3",
        retentionDays: 10,
        s3: {
          endpoint: "",
          region: "auto",
          bucket: "",
          accessKeyId: "",
          publicBaseUrl: "",
          forcePathStyle: true,
        },
      }),
    });
    expect(badS3.status).toBe(400);

    const tested = await admin.json<{ ok: boolean; message: string }>(
      "/api/cms/settings/storage/test",
      jsonBody({ driver: "local" }),
    );
    expect(tested.body.ok).toBe(true);
    expect(tested.body.message).toBe("Koneksi storage berhasil.");

    const listed = await admin.json<{ workspaces: Array<{ id: string; driveConnected: boolean }> }>(
      "/api/cms/settings/storage",
    );
    expect(listed.status).toBe(200);
    expect(listed.body.workspaces.length).toBeGreaterThan(0);
    expect(listed.body.workspaces.every((row) => !row.driveConnected)).toBe(true);
  });

  it("purges expired local assets and never touches drive assets", async () => {
    const account = await createAccount({ email: "sweep@example.test" });
    const storage = await resolveStorage(account.workspace.id);
    const past = new Date(Date.now() - 60_000);

    const localKey = `workspaces/${account.workspace.id}/generations/${randomUUID()}.svg`;
    await storage.driver.put(localKey, Buffer.from("<svg/>", "utf8"), "image/svg+xml");
    const [localAsset] = await db
      .insert(mediaAssets)
      .values({
        workspaceId: account.workspace.id,
        key: localKey,
        mime: "image/svg+xml",
        size: 6,
        driver: storage.kind,
        expiresAt: past,
      })
      .returning();

    const [driveAsset] = await db
      .insert(mediaAssets)
      .values({
        workspaceId: account.workspace.id,
        key: `workspaces/${account.workspace.id}/generations/${randomUUID()}.mp4`,
        mime: "video/mp4",
        size: 4,
        driver: "gdrive",
        externalId: "drive-file-1",
        expiresAt: past,
      })
      .returning();

    const result = await purgeExpiredMedia(10);
    expect(result.purged).toBe(1);

    const [purgedLocal] = await db
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.id, localAsset?.id ?? ""))
      .limit(1);
    expect(purgedLocal?.purgedAt).not.toBeNull();
    expect(await storage.driver.read(localKey)).toBeNull();

    const [keptDrive] = await db
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.id, driveAsset?.id ?? ""))
      .limit(1);
    expect(keptDrive?.purgedAt).toBeNull();
  });

  it("lists the workspace grid with totals, filters, and keyset pagination", async () => {
    const account = await createAccount({ email: "grid@example.test" });
    await db
      .update(workspaces)
      .set({ tokenBalance: 100 })
      .where(eq(workspaces.id, account.workspace.id));
    const client = createClient();
    await login(client, "grid@example.test");

    await uploadPng(client, "kain.png");
    await uploadPng(client, "rempah.png");
    await insertVideoAsset(account.workspace.id);

    const all = await client.json<{
      items: StorageItemBody[];
      nextCursor: string | null;
      totals: { count: number; bytes: number; images: number; videos: number };
    }>("/api/creator/storage");
    expect(all.status).toBe(200);
    expect(all.body.items).toHaveLength(3);
    expect(all.body.totals).toMatchObject({ count: 3, images: 2, videos: 1 });
    expect(all.body.totals.bytes).toBeGreaterThan(0);
    expect(all.body.nextCursor).toBeNull();

    const videos = await client.json<{ items: StorageItemBody[] }>("/api/creator/storage?type=VIDEO");
    expect(videos.body.items).toHaveLength(1);
    expect(videos.body.items[0]?.mime).toBe("video/mp4");
    expect(videos.body.items[0]?.source).toBe("GENERATION");

    const uploads = await client.json<{ items: StorageItemBody[] }>("/api/creator/storage?source=UPLOAD");
    expect(uploads.body.items).toHaveLength(2);
    expect(uploads.body.items.every((row) => row.source === "UPLOAD")).toBe(true);
    expect(uploads.body.items.every((row) => row.url.includes("sig="))).toBe(true);

    const searched = await client.json<{ items: StorageItemBody[] }>("/api/creator/storage?q=kain");
    expect(searched.body.items).toHaveLength(1);
    expect(searched.body.items[0]?.name).toContain("kain");

    const firstPage = await client.json<{ items: StorageItemBody[]; nextCursor: string | null }>(
      "/api/creator/storage?limit=2",
    );
    expect(firstPage.body.items).toHaveLength(2);
    expect(firstPage.body.nextCursor).not.toBeNull();

    const secondPage = await client.json<{ items: StorageItemBody[]; nextCursor: string | null }>(
      `/api/creator/storage?limit=2&cursor=${encodeURIComponent(firstPage.body.nextCursor ?? "")}`,
    );
    expect(secondPage.body.items).toHaveLength(1);
    expect(secondPage.body.nextCursor).toBeNull();

    const overlap = new Set([
      ...firstPage.body.items.map((row) => row.id),
      ...secondPage.body.items.map((row) => row.id),
    ]);
    expect(overlap.size).toBe(3);
  });

  it("lets the uploader delete an asset but not another member", async () => {
    const owner = await createAccount({ email: "owner@example.test" });
    const other = await createAccount({ email: "other@example.test" });
    await addMember(owner.workspace.id, other.user.id, "MEMBER");

    const ownerClient = createClient();
    await login(ownerClient, "owner@example.test");
    const asset = await uploadPng(ownerClient, "milik-owner.png");

    const otherClient = createClient();
    await login(otherClient, "other@example.test");
    await activateWorkspace(otherClient, owner.workspace.id);

    const [row] = await db.select().from(mediaAssets).where(eq(mediaAssets.key, asset.key)).limit(1);
    const assetId = row?.id ?? "";

    const denied = await otherClient.json<{ error: { message: string } }>(
      `/api/creator/storage/${assetId}`,
      { method: "DELETE" },
    );
    expect(denied.status).toBe(403);
    expect(denied.body.error.message).toBe("Anda tidak dapat menghapus aset ini.");

    const deleted = await ownerClient.request(`/api/creator/storage/${assetId}`, { method: "DELETE" });
    expect(deleted.status).toBe(204);

    const [after] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId)).limit(1);
    expect(after?.purgedAt).not.toBeNull();

    const grid = await ownerClient.json<{ items: StorageItemBody[] }>("/api/creator/storage");
    expect(grid.body.items.find((item) => item.id === assetId)).toBeUndefined();
  });

  it("refuses to connect Google Drive with an unparsable service account", async () => {
    const account = await createAccount({ email: "drive@example.test" });
    const client = createClient();
    await login(client, "drive@example.test");

    const status = await client.json<{ connected: boolean }>(
      `/api/creator/workspaces/${account.workspace.id}/storage/drive`,
    );
    expect(status.body.connected).toBe(false);

    const rejected = await client.json<{ error: { message: string } }>(
      `/api/creator/workspaces/${account.workspace.id}/storage/drive`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          serviceAccountEmail: "svc@project.iam.gserviceaccount.com",
          privateKey: "not json",
          folderId: "folder-1",
        }),
      },
    );
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.message).toBe("Isi JSON service account tidak valid.");
  });
});

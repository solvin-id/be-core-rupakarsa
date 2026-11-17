import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "../../src/db/client.js";
import { mediaAssets } from "../../src/db/schema.js";
import { putAsset } from "../../src/services/storage-service.js";
import {
  createAccount,
  createClient,
  login,
  resetDatabase,
} from "./helpers.js";

const MP4_BYTES = Buffer.from([0x00, 0x00, 0x00, 0x18]);

async function seedAsset(workspaceId: string) {
  const key = `workspaces/${workspaceId}/generations/${crypto.randomUUID()}.mp4`;
  const { asset } = await putAsset(workspaceId, key, MP4_BYTES, "video/mp4");
  return { key, asset };
}

describe("media streaming", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("serves the asset to its own workspace with range and cache headers", async () => {
    const account = await createAccount({ email: "media-owner@example.test" });
    const client = createClient();
    await login(client, "media-owner@example.test");
    const { key } = await seedAsset(account.workspace.id);

    const response = await client.request(`/media/${key}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("cache-control")).toContain("private");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("vary")).toContain("Cookie");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Number(response.headers.get("content-length"))).toBe(MP4_BYTES.byteLength);

    const etag = response.headers.get("etag");
    expect(etag).not.toBeNull();
    await response.body?.cancel();

    const revalidated = await client.request(`/media/${key}`, {
      headers: { "if-none-match": etag ?? "" },
    });
    expect(revalidated.status).toBe(304);
    await revalidated.body?.cancel();
  });

  it("returns 206 for a byte range so a video can seek", async () => {
    const account = await createAccount({ email: "media-range@example.test" });
    const client = createClient();
    await login(client, "media-range@example.test");
    const { key } = await seedAsset(account.workspace.id);

    const response = await client.request(`/media/${key}`, { headers: { range: "bytes=0-1" } });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 0-1/${MP4_BYTES.byteLength}`);
    expect(response.headers.get("content-length")).toBe("2");

    const body = Buffer.from(await response.arrayBuffer());
    expect(body).toEqual(MP4_BYTES.subarray(0, 2));

    const suffix = await client.request(`/media/${key}`, { headers: { range: "bytes=-2" } });
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get("content-range")).toBe(`bytes 2-3/${MP4_BYTES.byteLength}`);
    expect(Buffer.from(await suffix.arrayBuffer())).toEqual(MP4_BYTES.subarray(2));
  });

  it("hides the asset from anonymous callers and other workspaces", async () => {
    const owner = await createAccount({ email: "media-a@example.test" });
    const { key } = await seedAsset(owner.workspace.id);

    const anonymous = await createClient().request(`/media/${key}`);
    expect(anonymous.status).toBe(404);
    await anonymous.body?.cancel();

    await createAccount({ email: "media-b@example.test" });
    const other = createClient();
    await login(other, "media-b@example.test");
    const stranger = await other.request(`/media/${key}`);
    expect(stranger.status).toBe(404);
    await stranger.body?.cancel();
  });

  it("rejects traversal keys without touching the driver", async () => {
    const account = await createAccount({ email: "media-traversal@example.test" });
    const client = createClient();
    await login(client, "media-traversal@example.test");

    // A row that exists in the database is not enough: the key itself must be safe.
    const unsafeKey = `workspaces/${account.workspace.id}/generations/../../../../etc/passwd`;
    await db.insert(mediaAssets).values({
      workspaceId: account.workspace.id,
      key: unsafeKey,
      mime: "video/mp4",
      size: 4,
      driver: "local",
    });

    const encoded = await client.request("/media/%2e%2e/%2e%2e/etc/passwd");
    expect(encoded.status).toBe(404);
    await encoded.body?.cancel();

    const normalized = await client.request("/media/workspaces/a/generations/../../../../etc/passwd");
    expect(normalized.status).toBe(404);
    await normalized.body?.cancel();

    const [row] = await db.select().from(mediaAssets).where(eq(mediaAssets.key, unsafeKey)).limit(1);
    expect(row?.purgedAt).toBeNull();
  });
});

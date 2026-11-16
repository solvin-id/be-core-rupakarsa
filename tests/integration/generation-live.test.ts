import { once } from "node:events";

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// The render registry reads PROVIDER_MODE when the app boots, so this file opts into live mode
// before importing any module that parses env.
process.env.PROVIDER_MODE = "live";

const { encryptSecret } = await import("../../src/crypto/encryption.js");
const { db } = await import("../../src/db/client.js");
const { aiProviders, generations, mediaAssets, workspaces } = await import("../../src/db/schema.js");
const helpers = await import("./helpers.js");

const MP4_BYTES = Buffer.from([0x00, 0x00, 0x00, 0x18]);
let server: ReturnType<typeof serve> | null = null;
let mockBase = "";
let statusCalls = 0;
const submissions: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  const app = new Hono();
  app.post("/v1/generations", async (c) => {
    submissions.push((await c.req.json()) as Record<string, unknown>);
    return c.json({ id: "job-123" });
  });
  app.get("/v1/generations/:id", (c) => {
    statusCalls += 1;
    if (statusCalls === 1) return c.json({ status: "in_progress" });
    return c.json({ status: "completed", output: [{ url: `${mockBase}/file.mp4` }] });
  });
  app.get("/file.mp4", (c) => c.body(new Uint8Array(MP4_BYTES), 200, { "content-type": "video/mp4" }));

  server = serve({ fetch: app.fetch, port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock provider did not bind");
  mockBase = `http://127.0.0.1:${address.port}`;
});

afterAll(() => {
  server?.close();
});

describe("live higgsfield render", () => {
  beforeEach(async () => {
    statusCalls = 0;
    submissions.length = 0;
    await helpers.resetDatabase();
    await db
      .update(aiProviders)
      .set({
        baseUrl: mockBase,
        apiKeyEncrypted: encryptSecret("keyid:keysecret"),
        apiKeyMasked: "key••••••cret",
        isActive: true,
      })
      .where(eq(aiProviders.code, "HIGGSFIELD"));
  });

  it("stores the provider mp4 with its real mime and job id", async () => {
    const client = helpers.createClient();
    const account = await helpers.createAccount({ email: "live@example.test" });
    await db
      .update(workspaces)
      .set({ tokenBalance: 200 })
      .where(eq(workspaces.id, account.workspace.id));
    await helpers.login(client, "live@example.test");
    const folder = await helpers.createFolder(client, "Live Render");
    const model = await helpers.modelByCode("wan-qwen-5s");

    const created = await client.json<{ generation: { id: string } }>(
      "/api/creator/generations",
      helpers.jsonBody({
        folderId: folder.id,
        modelId: model.id,
        rawPrompt: "Uap rendang",
        planMode: false,
        finalPrompt: "Cinematic close-up of steam",
        selectedParams: { durationSec: 5, resolution: "1080p", aspectRatio: "16:9" },
      }),
    );
    expect(created.status).toBe(201);

    const finished = await helpers.pollGeneration(client, created.body.generation.id, [
      "COMPLETED",
      "FAILED",
    ]);
    expect(finished.status).toBe("COMPLETED");
    expect(finished.outputUrl).not.toBeNull();
    expect(finished.outputUrl).not.toContain("stub_");

    const [row] = await db
      .select()
      .from(generations)
      .where(eq(generations.id, created.body.generation.id))
      .limit(1);
    expect(row?.externalJobId).toBe("job-123");
    expect(row?.outputMime).toBe("video/mp4");
    expect(row?.outputSize).toBe(MP4_BYTES.byteLength);

    const assetRows = await db.select().from(mediaAssets);
    const rendered = assetRows.find((item) => item.key.includes(created.body.generation.id));
    expect(rendered?.mime).toBe("video/mp4");
    expect(rendered?.size).toBe(MP4_BYTES.byteLength);
    expect(rendered?.workspaceId).toBe(account.workspace.id);

    const key = (finished.outputUrl ?? "").split("/media/")[1] ?? "";
    expect(key).toContain(`workspaces/${account.workspace.id}/generations/`);
    const media = await client.request(`/media/${key}`);
    expect(media.status).toBe(200);
    expect(media.headers.get("content-type")).toBe("video/mp4");
    expect(media.headers.get("cache-control")).toContain("immutable");

    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({
      model: "wan-qwen-5s",
      duration: 5,
      resolution: "1080p",
      aspect_ratio: "16:9",
    });
  });
});

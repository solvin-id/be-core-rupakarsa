import { once } from "node:events";

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// The render registry reads PROVIDER_MODE when the app boots, so this file opts into live mode
// before importing any module that parses env.
process.env.PROVIDER_MODE = "live";

const { db } = await import("../../src/db/client.js");
const { generations, mediaAssets, workspaces } = await import("../../src/db/schema.js");
const helpers = await import("./helpers.js");

const MP4_BYTES = Buffer.from([0x00, 0x00, 0x00, 0x18]);
let server: ReturnType<typeof serve> | null = null;
let mockBase = "";
let statusCalls = 0;
let failPolls = false;
const submissions: Array<Record<string, unknown>> = [];
let downloadCalls = 0;

beforeAll(async () => {
  const app = new Hono();
  app.post("/v1/videos/generations", async (c) => {
    submissions.push((await c.req.json()) as Record<string, unknown>);
    return c.json({ id: "job-vid-1", status: "rendering" });
  });
  app.get("/v1/videos/:id", (c) => {
    statusCalls += 1;
    if (failPolls) return c.json({ status: "failed", failure_reason: "Kapasitas penuh, coba lagi." });
    if (statusCalls === 1) return c.json({ status: "rendering" });
    return c.json({ status: "done", url: `${mockBase}/v1/videos/${c.req.param("id")}/content` });
  });
  app.get("/v1/videos/:id/content", (c) => {
    downloadCalls += 1;
    return c.body(new Uint8Array(MP4_BYTES), 200, { "content-type": "video/mp4" });
  });

  server = serve({ fetch: app.fetch, port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock provider did not bind");
  mockBase = `http://127.0.0.1:${address.port}`;
});

afterAll(() => {
  server?.close();
});

interface VideoFixture {
  client: ReturnType<typeof helpers.createClient>;
  folderId: string;
  modelId: string;
  workspaceId: string;
}

/** Creates the mock provider, one VIDEO model, an account with credit, and a folder. */
async function videoFixture(email: string): Promise<VideoFixture> {
  const admin = helpers.createClient();
  await helpers.login(admin, process.env.SEED_SUPERADMIN_EMAIL ?? "admin@rupakarsa.id");
  const provider = await admin.json<{ id: string }>(
    "/api/cms/providers",
    helpers.jsonBody({
      name: "Mock Video",
      code: "mock-video",
      baseUrl: `${mockBase}/v1`,
      apiKey: "mock-secret-key",
      modelsPath: "/models",
      isActive: true,
    }),
  );
  expect(provider.status).toBe(201);

  const model = await admin.json<{ id: string }>(
    "/api/cms/models",
    helpers.jsonBody({
      providerId: provider.body.id,
      code: "vid-model",
      displayName: "Video Model",
      mediaType: "VIDEO",
      allowedParams: { durations: [5], resolutions: ["720p"], aspectRatios: ["16:9"] },
      tokenCost: 5,
      isActive: true,
    }),
  );
  expect(model.status).toBe(201);

  const account = await helpers.createAccount({ email });
  await db.execute(`update workspaces set token_balance = 100 where id = '${account.workspace.id}'`);

  const client = helpers.createClient();
  await helpers.login(client, email);
  const folder = await helpers.createFolder(client, "Video Async");

  return {
    client,
    folderId: folder.id,
    modelId: model.body.id,
    workspaceId: account.workspace.id,
  };
}

async function submitVideo(fixture: VideoFixture) {
  const created = await fixture.client.json<{ generation: { id: string } }>(
    "/api/creator/generations",
    helpers.jsonBody({
      folderId: fixture.folderId,
      modelId: fixture.modelId,
      rawPrompt: "Video uji",
      planMode: false,
      finalPrompt: "Video uji",
      selectedParams: { durationSec: 5, resolution: "720p", aspectRatio: "16:9" },
    }),
  );
  expect(created.status).toBe(201);
  return created.body.generation.id;
}

describe("async video render", () => {
  beforeEach(async () => {
    statusCalls = 0;
    failPolls = false;
    downloadCalls = 0;
    submissions.length = 0;
    await helpers.resetDatabase();
  });

  it("submits, polls, downloads, and stores the provider clip", async () => {
    const fixture = await videoFixture("video@example.test");
    const generationId = await submitVideo(fixture);

    const finished = await helpers.pollGeneration(fixture.client, generationId, [
      "COMPLETED",
      "FAILED",
    ]);
    expect(finished.status).toBe("COMPLETED");
    expect(finished.outputUrl).toContain(`workspaces/${fixture.workspaceId}/generations/`);

    const [row] = await db
      .select()
      .from(generations)
      .where(eq(generations.id, generationId))
      .limit(1);
    expect(row?.externalJobId).toBe("job-vid-1");
    expect(row?.outputMime).toBe("video/mp4");
    expect(row?.outputSize).toBe(MP4_BYTES.byteLength);

    const assets = await db.select().from(mediaAssets);
    const rendered = assets.find((asset) => asset.key.includes(generationId));
    expect(rendered?.mime).toBe("video/mp4");
    expect(rendered?.durationMs).toBe(5000);

    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({
      model: "vid-model",
      prompt: "Video uji",
      duration: 5,
      resolution: "720p",
      aspect_ratio: "16:9",
    });
    expect(statusCalls).toBeGreaterThanOrEqual(2);
    expect(downloadCalls).toBe(1);
  });

  it("fails the generation and refunds the hold when the provider reports failure", async () => {
    failPolls = true;
    const fixture = await videoFixture("video-fail@example.test");
    const generationId = await submitVideo(fixture);

    const finished = await helpers.pollGeneration(fixture.client, generationId, [
      "COMPLETED",
      "FAILED",
    ]);
    expect(finished.status).toBe("FAILED");
    expect(finished.refunded).toBe(true);

    const response = await fixture.client.json<{ errorMessage: string | null }>(
      `/api/creator/generations/${generationId}`,
    );
    expect(response.body.errorMessage).toContain("Kapasitas penuh");

    const [workspace] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, fixture.workspaceId))
      .limit(1);
    expect(workspace?.tokenBalance).toBe(100);
    expect(downloadCalls).toBe(0);
  });
});

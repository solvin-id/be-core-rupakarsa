import { once } from "node:events";

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// The render registry reads PROVIDER_MODE when the app boots, so this file opts into live mode
// before importing any module that parses env.
process.env.PROVIDER_MODE = "live";

const { db } = await import("../../src/db/client.js");
const { generations } = await import("../../src/db/schema.js");
const helpers = await import("./helpers.js");

const MP4_BYTES = Buffer.from([0x00, 0x00, 0x00, 0x18]);
let server: ReturnType<typeof serve> | null = null;
let mockBase = "";
let statusCalls = 0;

beforeAll(async () => {
  const app = new Hono();
  app.post("/v1/videos/generations", (c) => c.json({ id: "job-progress-1", status: "rendering" }));
  app.get("/v1/videos/:id", (c) => {
    statusCalls += 1;
    if (statusCalls === 1) return c.json({ status: "rendering" });
    return c.json({ status: "done", url: `${mockBase}/v1/videos/${c.req.param("id")}/content` });
  });
  app.get("/v1/videos/:id/content", (c) =>
    c.body(new Uint8Array(MP4_BYTES), 200, { "content-type": "video/mp4" }),
  );

  server = serve({ fetch: app.fetch, port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock provider did not bind");
  mockBase = `http://127.0.0.1:${address.port}`;
});

afterAll(() => {
  server?.close();
});

interface ProgressFixture {
  client: ReturnType<typeof helpers.createClient>;
  folderId: string;
  modelId: string;
}

async function fixture(email: string): Promise<ProgressFixture> {
  const admin = helpers.createClient();
  await helpers.login(admin, process.env.SEED_SUPERADMIN_EMAIL ?? "admin@rupakarsa.id");
  const provider = await admin.json<{ id: string }>(
    "/api/cms/providers",
    helpers.jsonBody({
      name: "Mock Progress",
      code: "mock-progress",
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
      code: "progress-model",
      displayName: "Progress Model",
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
  const folder = await helpers.createFolder(client, "Progress");
  return { client, folderId: folder.id, modelId: model.body.id };
}

async function submit(fixtureValue: ProgressFixture): Promise<string> {
  const created = await fixtureValue.client.json<{ generation: { id: string } }>(
    "/api/creator/generations",
    helpers.jsonBody({
      folderId: fixtureValue.folderId,
      modelId: fixtureValue.modelId,
      rawPrompt: "Video progres",
      planMode: false,
      finalPrompt: null,
      selectedParams: { durationSec: 5, resolution: "720p", aspectRatio: "16:9" },
    }),
  );
  expect(created.status).toBe(201);
  return created.body.generation.id;
}

/**
 * Real polling is required here: the worker's own 5 s provider poll interval runs on the platform
 * clock, so fake timers would freeze the code under test instead of the wait.
 */
async function pollUntil(
  client: ProgressFixture["client"],
  generationId: string,
  predicate: (row: {
    status: string;
    startedAt: string | null;
    providerStatus: string | null;
  }) => boolean,
  timeoutMs = 20_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await client.json<{
      status: string;
      startedAt: string | null;
      providerStatus: string | null;
    }>(`/api/creator/generations/${generationId}`);
    if (response.status === 200 && predicate(response.body)) return response.body;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`generation ${generationId} never matched the progress predicate`);
}

describe("render progress state", () => {
  beforeEach(async () => {
    statusCalls = 0;
    await helpers.resetDatabase();
  });

  it("persists the start time and the provider status while rendering", async () => {
    const fx = await fixture("progress@example.test");
    const generationId = await submit(fx);

    const rendering = await pollUntil(
      fx.client,
      generationId,
      (row) => row.status === "RENDERING" && row.providerStatus === "rendering",
    );
    expect(rendering.startedAt).not.toBeNull();
    expect(rendering.providerStatus).toBe("rendering");

    const active = await fx.client.json<
      Array<{ id: string; folderName: string; startedAt: string | null }>
    >("/api/creator/generations?active=true");
    expect(active.status).toBe(200);
    expect(active.body.some((row) => row.id === generationId)).toBe(true);
    expect(active.body.find((row) => row.id === generationId)?.folderName).toBe("Progress");

    const finished = await pollUntil(fx.client, generationId, (row) => row.status === "COMPLETED");
    expect(finished.startedAt).toBe(rendering.startedAt);

    const [row] = await db
      .select()
      .from(generations)
      .where(eq(generations.id, generationId))
      .limit(1);
    expect(row?.startedAt).not.toBeNull();

    const drained = await fx.client.json<unknown[]>("/api/creator/generations?active=true");
    expect(drained.body).toEqual([]);
  });
});

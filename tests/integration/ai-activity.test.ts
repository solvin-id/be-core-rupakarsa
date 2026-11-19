import { once } from "node:events";

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// The render registry reads PROVIDER_MODE when the app boots, so this file opts into live mode.
process.env.PROVIDER_MODE = "live";

const { db } = await import("../../src/db/client.js");
const { generations, workspaces } = await import("../../src/db/schema.js");
const helpers = await import("./helpers.js");

const MP4_BYTES = Buffer.from([0x00, 0x00, 0x00, 0x18]);
let server: ReturnType<typeof serve> | null = null;
let mockBase = "";
let statusCalls = 0;

beforeAll(async () => {
  const app = new Hono();
  app.post("/v1/videos/generations", (c) => c.json({ id: "job-activity-1", status: "queued" }));
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

interface ActivityRow {
  kind: string;
  status: string;
  modelName: string;
  latencyMs: number;
  tokensUsed: number;
  metadata: Record<string, unknown>;
}

interface ActivityPage {
  rows: ActivityRow[];
  total: number;
  page: number;
  limit: number;
  stats: { total: number; success: number; error: number; avgLatencyMs: number; tokensUsed: number };
}

async function adminClient() {
  const client = helpers.createClient();
  await helpers.login(client, process.env.SEED_SUPERADMIN_EMAIL ?? "admin@rupakarsa.id");
  return client;
}

/** One live video provider whose job completes after a single status poll. */
async function createVideoModel(admin: ReturnType<typeof helpers.createClient>): Promise<string> {
  const provider = await admin.json<{ id: string }>(
    "/api/cms/providers",
    helpers.jsonBody({
      name: "Mock Activity",
      code: "mock-activity",
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
      code: "activity-model",
      displayName: "Activity Model",
      mediaType: "VIDEO",
      allowedParams: { durations: [5], resolutions: ["720p"], aspectRatios: ["16:9"] },
      tokenCost: 5,
      isActive: true,
    }),
  );
  expect(model.status).toBe(201);
  return model.body.id;
}

describe("CMS AI activity log", () => {
  beforeEach(async () => {
    statusCalls = 0;
    await helpers.resetDatabase();
  });

  it("records a plan call, filters by kind and searches the model name", async () => {
    const admin = await adminClient();
    const account = await helpers.createAccount({ email: "activity@example.test" });
    await db
      .update(workspaces)
      .set({ tokenBalance: 100 })
      .where(eq(workspaces.id, account.workspace.id));

    const client = helpers.createClient();
    await helpers.login(client, "activity@example.test");
    const folder = await helpers.createFolder(client, "Aktivitas");
    const renderModel = await helpers.modelByCode("wan-qwen-10s");

    const plan = await client.json<{ blueprint: { prompt: string } }>(
      "/api/creator/generations/plan",
      helpers.jsonBody({
        folderId: folder.id,
        modelId: renderModel.id,
        rawPrompt: "Lampu minyak di lorong batu",
        durationSec: 10,
        resolution: "1080p",
        aspectRatio: "16:9",
        attachmentKeys: [],
        contextIds: [],
      }),
    );
    expect(plan.status).toBe(200);

    const page = await admin.json<ActivityPage>(
      "/api/cms/ai-activity?kind=PLAN&status=SUCCESS&page=1&limit=10&orderBy=createdAt&order=desc",
    );
    expect(page.status).toBe(200);
    expect(page.body.total).toBeGreaterThanOrEqual(1);
    expect(page.body.rows[0]?.kind).toBe("PLAN");
    expect(page.body.rows[0]?.status).toBe("SUCCESS");
    expect(page.body.rows[0]?.modelName.length).toBeGreaterThan(0);
    expect(page.body.rows[0]?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(page.body.stats.success).toBeGreaterThanOrEqual(1);

    const searched = await admin.json<ActivityPage>(
      `/api/cms/ai-activity?q=${encodeURIComponent("Wan 3.0 10s")}&page=1&limit=10&orderBy=createdAt&order=desc`,
    );
    expect(searched.body.rows.some((row) => row.kind === "PLAN")).toBe(true);
  });

  it("records the render lifecycle as separate activity rows", async () => {
    const admin = await adminClient();
    const modelId = await createVideoModel(admin);

    const account = await helpers.createAccount({ email: "activity-render@example.test" });
    await db
      .update(workspaces)
      .set({ tokenBalance: 100 })
      .where(eq(workspaces.id, account.workspace.id));
    const client = helpers.createClient();
    await helpers.login(client, "activity-render@example.test");
    const folder = await helpers.createFolder(client, "Render");

    const created = await client.json<{ generation: { id: string } }>(
      "/api/creator/generations",
      helpers.jsonBody({
        folderId: folder.id,
        modelId,
        rawPrompt: "Ombak",
        planMode: true,
        finalPrompt: "Slow cinematic waves at sunset",
        attachmentKeys: [],
        selectedParams: { durationSec: 5, resolution: "720p", aspectRatio: "16:9" },
      }),
    );
    expect(created.status).toBe(201);

    await helpers.pollGeneration(client, created.body.generation.id, ["COMPLETED", "FAILED"]);

    const submitted = await admin.json<ActivityPage>(
      `/api/cms/ai-activity?kind=RENDER_SUBMIT&page=1&limit=10&orderBy=createdAt&order=desc`,
    );
    expect(submitted.body.total).toBeGreaterThanOrEqual(1);
    expect(submitted.body.rows[0]?.status).toBe("SUCCESS");
    expect(submitted.body.rows[0]?.metadata.providerName).toBe("Mock Activity");

    const completed = await admin.json<ActivityPage>(
      `/api/cms/ai-activity?kind=RENDER_COMPLETE&page=1&limit=10&orderBy=createdAt&order=desc`,
    );
    expect(completed.body.total).toBeGreaterThanOrEqual(1);
    expect(completed.body.rows[0]?.modelName).toBe("Activity Model");

    const generation = await db
      .select()
      .from(generations)
      .where(eq(generations.id, created.body.generation.id))
      .limit(1);
    expect(generation[0]?.status).toBe("COMPLETED");

    const sorted = await admin.json<ActivityPage>(
      "/api/cms/ai-activity?limit=10&orderBy=latencyMs&order=asc",
    );
    const latencies = sorted.body.rows.map((row) => row.latencyMs);
    expect([...latencies].sort((a, b) => a - b)).toEqual(latencies);

    const paged = await admin.json<ActivityPage>("/api/cms/ai-activity?page=2&limit=10");
    expect(paged.body.page).toBe(2);
    expect(paged.body.limit).toBe(10);
  });
});

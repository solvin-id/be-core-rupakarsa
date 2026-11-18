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
const { aiModels, aiProviders, generations } = await import("../../src/db/schema.js");
const helpers = await import("./helpers.js");

const MP4_BYTES = Buffer.from([0x00, 0x00, 0x00, 0x18]);
let server: ReturnType<typeof serve> | null = null;
let mockBase = "";
let statusCalls = 0;
const submissions: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  const app = new Hono();
  // Higgsfield: one path per workflow, keyed by the endpoint id.
  app.post("/alibaba/wan-3.0/text-to-video", async (c) => {
    submissions.push((await c.req.json()) as Record<string, unknown>);
    return c.json({
      status: "queued",
      request_id: "req-1",
      status_url: `${mockBase}/requests/req-1/status`,
    });
  });
  app.post("/kling-video/v2.6/pro/text-to-video", async (c) => {
    submissions.push((await c.req.json()) as Record<string, unknown>);
    return c.json({ status: "queued", request_id: "req-2" });
  });
  app.get("/requests/:id/status", (c) => {
    statusCalls += 1;
    if (statusCalls === 1) return c.json({ status: "in_progress", request_id: c.req.param("id") });
    return c.json({
      status: "completed",
      request_id: c.req.param("id"),
      video: { url: `${mockBase}/out.mp4` },
    });
  });
  app.get("/out.mp4", (c) => c.body(new Uint8Array(MP4_BYTES), 200, { "content-type": "video/mp4" }));

  server = serve({ fetch: app.fetch, port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock provider did not bind");
  mockBase = `http://127.0.0.1:${address.port}`;
});

afterAll(() => {
  server?.close();
});

async function higgsfieldFixture(
  modelCode: string,
  endpointId: string,
  overrides: { resolutions?: string[] } = {},
): Promise<{ client: ReturnType<typeof helpers.createClient>; folderId: string; modelId: string }> {
  await db
    .update(aiProviders)
    .set({
      baseUrl: mockBase,
      apiKeyEncrypted: encryptSecret("keyid:keysecret"),
      apiKeyMasked: "key••••••cret",
      isActive: true,
    })
    .where(eq(aiProviders.code, "HIGGSFIELD"));
  const model = await helpers.modelByCode(modelCode);
  await db
    .update(aiModels)
    .set({
      providerModelId: endpointId,
      ...(overrides.resolutions ? { allowedParams: { ...model.allowedParams, resolutions: overrides.resolutions } } : {}),
    })
    .where(eq(aiModels.id, model.id));

  const account = await helpers.createAccount({ email: `${modelCode.replaceAll("/", "-")}@example.test` });
  await db.execute(`update workspaces set token_balance = 100 where id = '${account.workspace.id}'`);
  const client = helpers.createClient();
  await helpers.login(client, `${modelCode.replaceAll("/", "-")}@example.test`);
  const folder = await helpers.createFolder(client, "Higgsfield");
  return { client, folderId: folder.id, modelId: model.id };
}

async function submit(
  fixture: { client: ReturnType<typeof helpers.createClient>; folderId: string; modelId: string },
  selectedParams: Record<string, unknown>,
): Promise<string> {
  const created = await fixture.client.json<{ generation: { id: string } }>(
    "/api/creator/generations",
    helpers.jsonBody({
      folderId: fixture.folderId,
      modelId: fixture.modelId,
      rawPrompt: "Ombak senja",
      planMode: false,
      finalPrompt: "Slow cinematic waves at sunset",
      selectedParams,
    }),
  );
  expect(created.status).toBe(201);
  return created.body.generation.id;
}

describe("higgsfield async video render", () => {
  beforeEach(async () => {
    statusCalls = 0;
    submissions.length = 0;
    await helpers.resetDatabase();
  });

  it("submits to the workflow endpoint, polls its status url, and stores the clip", async () => {
    const fixture = await higgsfieldFixture("wan-qwen-10s", "alibaba/wan-3.0/text-to-video");
    const generationId = await submit(fixture, {
      durationSec: 10,
      resolution: "720p",
      aspectRatio: "16:9",
    });

    const finished = await helpers.pollGeneration(fixture.client, generationId, [
      "COMPLETED",
      "FAILED",
    ]);
    expect(finished.status).toBe("COMPLETED");
    expect(finished.outputUrl).toContain("/generations/");

    const key = (finished.outputUrl ?? "").split("/media/")[1] ?? "";
    const media = await fixture.client.request(`/media/${key}`);
    expect(media.status).toBe(200);
    expect(media.headers.get("content-type")).toBe("video/mp4");
    expect(media.headers.get("cache-control")).toContain("immutable");

    const [row] = await db
      .select()
      .from(generations)
      .where(eq(generations.id, generationId))
      .limit(1);
    expect(row?.externalJobId).toBe("req-1");
    expect(row?.outputMime).toBe("video/mp4");
    expect(row?.outputSize).toBe(MP4_BYTES.byteLength);

    expect(submissions).toHaveLength(1);
    // Direct mode composes a production blueprint; the brief stays the subject.
    expect(String(submissions[0]?.prompt)).toContain("Ombak senja");
    expect(submissions[0]).toMatchObject({ duration: 10, resolution: "720p", aspect_ratio: "16:9" });
    expect(statusCalls).toBeGreaterThanOrEqual(2);
  });

  it("sends only the fields the workflow declares", async () => {
    // Kling 2.6 exposes duration and aspect_ratio but no resolution field.
    const fixture = await higgsfieldFixture("kling-2.6-pro", "kling-video/v2.6/pro/text-to-video", {
      resolutions: ["720p"],
    });
    const generationId = await submit(fixture, {
      durationSec: 5,
      resolution: "720p",
      aspectRatio: "16:9",
    });

    const finished = await helpers.pollGeneration(fixture.client, generationId, [
      "COMPLETED",
      "FAILED",
    ]);
    expect(finished.status).toBe("COMPLETED");
    expect(submissions[0]).toMatchObject({ duration: 5, aspect_ratio: "16:9" });
    expect(submissions[0]).not.toHaveProperty("resolution");
  });
});

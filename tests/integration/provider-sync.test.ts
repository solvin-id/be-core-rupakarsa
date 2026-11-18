import { once } from "node:events";

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "../../src/db/client.js";
import { aiModels, aiProviders } from "../../src/db/schema.js";
import { env } from "../../src/env.js";
import { eq } from "drizzle-orm";
import { createClient, jsonBody, login, resetDatabase } from "./helpers.js";
import type { TestClient } from "./helpers.js";

let server: ReturnType<typeof serve> | null = null;
let baseUrl = "";

beforeAll(async () => {
  const app = new Hono();
  app.get("/v1/models", (c) =>
    c.json({
      data: [
        {
          id: "vid-1",
          name: "Video One",
          architecture: { input_modalities: ["TEXT", "IMAGE"], output_modalities: ["VIDEO"] },
        },
        {
          id: "img-1",
          name: "Image One",
          architecture: { input_modalities: ["TEXT"], output_modalities: ["IMAGE"] },
        },
        { id: "txt-1", name: "Text One", architecture: { output_modalities: ["TEXT"] } },
      ],
    }),
  );

  // kenari publishes capabilities as `modalities` plus the render options it accepts.
  app.get("/v2/models", (c) =>
    c.json({
      data: [
        {
          id: "veo-3.1-lite",
          name: "Veo 3.1 Lite",
          modalities: { input: ["text", "image"], output: ["video"] },
          video_durations: [8],
          video_resolutions: ["720p"],
        },
        { id: "beam-1-0:free", name: "Beam 1.0", modalities: { input: ["text"], output: ["text"] } },
      ],
    }),
  );

  server = serve({ fetch: app.fetch, port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock provider did not bind");
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});

afterAll(() => {
  server?.close();
});

async function adminClient(): Promise<TestClient> {
  const client = createClient();
  await login(client, env.SEED_SUPERADMIN_EMAIL, env.SEED_SUPERADMIN_PASSWORD);
  return client;
}

interface SyncBody {
  added: number;
  updated: number;
  skipped: number;
  models: Array<{
    code: string;
    providerModelId: string;
    outputCapabilities: string[];
    mediaType: string;
    allowedParams: { resolutions: string[]; aspectRatios: string[] };
  }>;
}

describe("provider model sync", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("imports renderable and text models, and never touches operator overrides", async () => {
    const client = await adminClient();

    const created = await client.json<{ id: string }>(
      "/api/cms/providers",
      jsonBody({
        name: "Mock Publisher",
        code: "mock-publisher",
        baseUrl,
        apiKey: "mock-secret-key",
        modelsPath: "/models",
        isActive: true,
      }),
    );
    expect(created.status).toBe(201);

    const preview = await client.json<{ models: Array<{ providerModelId: string }> }>(
      `/api/cms/providers/${created.body.id}/remote-models`,
    );
    expect(preview.status).toBe(200);
    expect(preview.body.models.map((row) => row.providerModelId).sort()).toEqual([
      "img-1",
      "txt-1",
      "vid-1",
    ]);

    const tested = await client.json<{ ok: boolean; message: string }>(
      `/api/cms/providers/${created.body.id}/test`,
      { method: "POST" },
    );
    expect(tested.body.ok).toBe(true);
    expect(tested.body.message).toContain("3 model terdeteksi");

    const first = await client.json<SyncBody>(
      `/api/cms/providers/${created.body.id}/sync-models`,
      { method: "POST" },
    );
    expect(first.status).toBe(200);
    expect(first.body.added).toBe(3);
    expect(first.body.updated).toBe(0);
    expect(first.body.skipped).toBe(0);
    expect(first.body.models).toHaveLength(3);

    const text = first.body.models.find((row) => row.code === "txt-1");
    expect(text).toMatchObject({
      mediaType: "TEXT",
      outputCapabilities: ["TEXT"],
      allowedParams: { resolutions: [], aspectRatios: [] },
    });

    const video = await client.json<Array<{ id: string; code: string; outputCapabilities: string[] }>>(
      `/api/cms/models?output=VIDEO&providerId=${created.body.id}`,
    );
    expect(video.status).toBe(200);
    expect(video.body).toHaveLength(1);
    expect(video.body[0]?.code).toBe("vid-1");

    const modelId = video.body[0]?.id;
    expect(modelId).toBeDefined();
    const patched = await client.json<{ tokenCost: number; isActive: boolean }>(
      `/api/cms/models/${modelId}`,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ tokenCost: 12, isActive: false }) },
    );
    expect(patched.status).toBe(200);

    const second = await client.json<SyncBody>(
      `/api/cms/providers/${created.body.id}/sync-models`,
      { method: "POST" },
    );
    expect(second.body.added).toBe(0);
    expect(second.body.updated).toBe(3);

    const [row] = await db.select().from(aiProviders).where(eq(aiProviders.id, created.body.id)).limit(1);
    expect(row?.lastSyncedAt).not.toBeNull();
    expect(row?.syncError).toBeNull();

    const afterSync = await client.json<Array<{ id: string; tokenCost: number; isActive: boolean; source: string }>>(
      `/api/cms/models?output=VIDEO&providerId=${created.body.id}`,
    );
    expect(afterSync.body[0]).toMatchObject({ id: modelId, tokenCost: 12, isActive: false, source: "SYNC" });
  });

  it("keeps catalog codes stable when a workflow endpoint is shared", async () => {
    const client = await adminClient();
    const providers = await client.json<Array<{ id: string; code: string }>>("/api/cms/providers");
    const fixed = providers.body.find((row) => row.code === "HIGGSFIELD");
    expect(fixed).toBeDefined();

    const first = await client.json<SyncBody>(`/api/cms/providers/${fixed?.id}/sync-models`, {
      method: "POST",
    });
    expect(first.status).toBe(200);
    // The seed already created every template row, so a sync only rewrites their provider ids.
    expect(first.body.added).toBe(0);
    expect(first.body.updated).toBe(13);

    const endpoint = "alibaba/wan-3.0/text-to-video";
    const wan = first.body.models
      .filter((row) => row.code === "wan-qwen-5s" || row.code === "wan-qwen-10s")
      .sort((a, b) => a.code.localeCompare(b.code));
    expect(wan.map((row) => row.code)).toEqual(["wan-qwen-10s", "wan-qwen-5s"]);
    expect(wan.every((row) => row.providerModelId === endpoint)).toBe(true);

    const second = await client.json<SyncBody>(`/api/cms/providers/${fixed?.id}/sync-models`, {
      method: "POST",
    });
    expect(second.body.added).toBe(0);
    expect(second.body.updated).toBe(13);
    expect(second.body.models).toHaveLength(13);

    const kling = await db
      .select()
      .from(aiModels)
      .where(eq(aiModels.code, "kling-2.6-pro"))
      .limit(1);
    expect(kling[0]?.providerModelId).toBe("kling-video/v2.6/pro/text-to-video");
    expect(kling[0]?.syncMetadata).toMatchObject({ requestFields: ["duration", "aspectRatio"] });
  });

  it("refuses to delete the fixed provider", async () => {
    const client = await adminClient();
    const providers = await client.json<Array<{ id: string; code: string; isFixed: boolean }>>(
      "/api/cms/providers",
    );
    const fixed = providers.body.find((row) => row.isFixed);
    expect(fixed?.code).toBe("HIGGSFIELD");

    const response = await client.json<{ error: { message: string } }>(
      `/api/cms/providers/${fixed?.id}`,
      { method: "DELETE" },
    );
    expect(response.status).toBe(409);
    expect(response.body.error.message).toBe("Provider tetap tidak dapat dihapus.");
  });

  it("reads kenari-style modalities and keeps the render options the catalog publishes", async () => {
    const client = await adminClient();
    const created = await client.json<{ id: string }>(
      "/api/cms/providers",
      jsonBody({
        name: "Kenari Shape",
        code: "kenari-shape",
        baseUrl: `${baseUrl.replace(/\/v1$/, "")}/v2`,
        apiKey: "kn-test-key",
        modelsPath: "/models",
        isActive: true,
      }),
    );
    expect(created.status).toBe(201);

    const tested = await client.json<{ ok: boolean; message: string }>(
      `/api/cms/providers/${created.body.id}/test`,
      { method: "POST" },
    );
    expect(tested.body.ok).toBe(true);
    expect(tested.body.message).toContain("2 model terdeteksi");

    const synced = await client.json<{ added: number; skipped: number }>(
      `/api/cms/providers/${created.body.id}/sync-models`,
      { method: "POST" },
    );
    expect(synced.body.added).toBe(2);
    expect(synced.body.skipped).toBe(0);

    const rows = await db
      .select()
      .from(aiModels)
      .where(eq(aiModels.providerId, created.body.id))
      .orderBy(aiModels.code);
    const video = rows.find((row) => row.code === "veo-3.1-lite");
    expect(video?.mediaType).toBe("VIDEO");
    expect(video?.inputCapabilities).toEqual(["TEXT", "IMAGE"]);
    expect(video?.allowedParams).toEqual({
      durations: [8],
      resolutions: ["720p"],
      aspectRatios: ["16:9", "9:16", "1:1"],
    });

    const text = rows.find((row) => row.code === "beam-1-0:free");
    expect(text?.mediaType).toBe("TEXT");
    expect(text?.outputCapabilities).toEqual(["TEXT"]);
    expect(text?.allowedParams).toEqual({ resolutions: [], aspectRatios: [] });
  });

  it("reports the upstream error and stores syncError when the publisher is unreachable", async () => {
    const client = await adminClient();
    const created = await client.json<{ id: string }>(
      "/api/cms/providers",
      jsonBody({
        name: "Broken Publisher",
        code: "broken",
        baseUrl: "http://127.0.0.1:54321/v1",
        apiKey: "mock-secret-key",
        modelsPath: "/models",
        isActive: true,
      }),
    );

    const failed = await client.json<{ error: { code: string; message: string } }>(
      `/api/cms/providers/${created.body.id}/sync-models`,
      { method: "POST" },
    );
    expect(failed.status).toBe(502);
    expect(failed.body.error.code).toBe("PROVIDER_UNREACHABLE");
    // The operator must see why, not undici's "fetch failed".
    expect(failed.body.error.message).toBe("Koneksi ke 127.0.0.1:54321 ditolak.");

    const [row] = await db.select().from(aiProviders).where(eq(aiProviders.id, created.body.id)).limit(1);
    expect(row?.syncError).toBe("Koneksi ke 127.0.0.1:54321 ditolak.");
  });
});

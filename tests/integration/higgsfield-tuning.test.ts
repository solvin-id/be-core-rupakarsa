import { once } from "node:events";

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// The render registry reads PROVIDER_MODE when the app boots, so this file opts into live mode.
process.env.PROVIDER_MODE = "live";

const { encryptSecret } = await import("../../src/crypto/encryption.js");
const { db } = await import("../../src/db/client.js");
const { aiModels, aiProviders, workspaces } = await import("../../src/db/schema.js");
const helpers = await import("./helpers.js");

const MP4_BYTES = Buffer.from([0x00, 0x00, 0x00, 0x18]);
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let server: ReturnType<typeof serve> | null = null;
let mockBase = "";
const submissions: Array<Record<string, unknown>> = [];
const characterBodies: Array<Record<string, unknown>> = [];
const polled = new Map<string, number>();

beforeAll(async () => {
  const app = new Hono();

  app.post("/v1/custom-references", async (c) => {
    characterBodies.push((await c.req.json()) as Record<string, unknown>);
    return c.json({ id: "char-1", status: "queued" });
  });
  app.get("/v1/custom-references/:id", (c) =>
    c.json({
      id: c.req.param("id"),
      status: "completed",
      thumbnail_url: "https://cdn.example.test/char-1.png",
    }),
  );

  // One path per workflow; the reference workflows carry their own fields.
  for (const endpoint of ["alibaba/wan-3.0/text-to-video", "alibaba/wan-3.0/image-to-video"]) {
    app.post(`/${endpoint}`, async (c) => {
      submissions.push((await c.req.json()) as Record<string, unknown>);
      return c.json({ status: "queued", request_id: `job-${submissions.length}` });
    });
  }
  app.post("/higgsfield-ai/soul/v2/standard", async (c) => {
    submissions.push((await c.req.json()) as Record<string, unknown>);
    return c.json({ status: "queued", request_id: `job-${submissions.length}` });
  });

  app.get("/requests/:id/status", (c) => {
    const id = c.req.param("id");
    const calls = (polled.get(id) ?? 0) + 1;
    polled.set(id, calls);
    if (calls === 1) return c.json({ status: "in_progress" });
    return c.json({ status: "completed", video: { url: `${mockBase}/out.mp4` } });
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

async function pointHiggsfieldAtMock(): Promise<void> {
  await db
    .update(aiProviders)
    .set({
      baseUrl: mockBase,
      apiKeyEncrypted: encryptSecret("keyid:keysecret"),
      apiKeyMasked: "key••••••cret",
      isActive: true,
    })
    .where(eq(aiProviders.code, "HIGGSFIELD"));
}

async function studioFixture(email: string) {
  const account = await helpers.createAccount({ email });
  await db.update(workspaces).set({ tokenBalance: 100 }).where(eq(workspaces.id, account.workspace.id));
  const client = helpers.createClient();
  await helpers.login(client, email);
  const folder = await helpers.createFolder(client, "Tuning");
  return { client, folderId: folder.id, workspaceId: account.workspace.id };
}

async function uploadPng(
  client: ReturnType<typeof helpers.createClient>,
): Promise<{ id: string; key: string }> {
  const form = new FormData();
  form.append("file", new File([PNG_BYTES], "frame.png", { type: "image/png" }));
  const uploaded = await client.json<{ id: string; key: string }>("/api/creator/uploads", {
    method: "POST",
    body: form,
  });
  if (uploaded.status !== 201) throw new Error(`upload failed: ${JSON.stringify(uploaded.body)}`);
  return { id: uploaded.body.id, key: uploaded.body.key };
}

interface CharacterBody {
  id: string;
  externalId: string | null;
  status: string;
  thumbnailUrl: string | null;
}

describe("higgsfield tuning", () => {
  beforeEach(async () => {
    submissions.length = 0;
    characterBodies.length = 0;
    polled.clear();
    await helpers.resetDatabase();
    await pointHiggsfieldAtMock();
  });

  it("trains a Soul ID from uploaded assets, lists it, and refreshes its provider state", async () => {
    const fx = await studioFixture("tuning-train@example.test");
    const first = await uploadPng(fx.client);
    const second = await uploadPng(fx.client);

    const created = await fx.client.json<CharacterBody>(
      "/api/creator/characters",
      helpers.jsonBody({
        name: "Mbok Srini",
        modelVersion: "v1",
        imageAssetIds: [first.id, second.id],
      }),
    );
    expect(created.status).toBe(201);
    expect(created.body.externalId).toBe("char-1");
    expect(created.body.status).toBe("QUEUED");

    expect(characterBodies).toHaveLength(1);
    const body = characterBodies[0] ?? {};
    expect(body.name).toBe("Mbok Srini");
    expect(body.model_version).toBe("v1");
    const images = body.input_images as Array<{ type: string; image_url: string }>;
    expect(images).toHaveLength(2);
    for (const image of images) {
      expect(image.type).toBe("image_url");
      expect(image.image_url).toContain("/media/");
    }

    const listed = await fx.client.json<CharacterBody[]>("/api/creator/characters");
    expect(listed.status).toBe(200);
    expect(listed.body.map((row) => row.externalId)).toContain("char-1");

    const refreshed = await fx.client.json<CharacterBody>(
      `/api/creator/characters/${created.body.id}/refresh`,
      { method: "POST" },
    );
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.status).toBe("COMPLETED");
    expect(refreshed.body.thumbnailUrl).toBe("https://cdn.example.test/char-1.png");
  });

  it("rejects Soul ID training from a workspace member", async () => {
    const fx = await studioFixture("tuning-owner@example.test");
    const member = await helpers.createAccount({ email: "tuning-member@example.test" });
    await helpers.addMember(fx.workspaceId, member.user.id, "MEMBER");

    const memberClient = helpers.createClient();
    await helpers.login(memberClient, "tuning-member@example.test");
    await helpers.activateWorkspace(memberClient, fx.workspaceId);

    const asset = await uploadPng(memberClient);
    const rejected = await memberClient.json<{ error: { message: string } }>(
      "/api/creator/characters",
      helpers.jsonBody({ name: "Bukan Admin", imageAssetIds: [asset.id] }),
    );
    expect(rejected.status).toBe(403);
    expect(characterBodies).toHaveLength(0);
  });

  it("sends the project Soul ID as custom_reference_id", async () => {
    const fx = await studioFixture("tuning-project-soul@example.test");
    const model = await helpers.modelByCode("soul-v2");
    const asset = await uploadPng(fx.client);

    const trained = await fx.client.json<CharacterBody>(
      "/api/creator/characters",
      helpers.jsonBody({ name: "Mbok Srini", modelVersion: "v1", imageAssetIds: [asset.id] }),
    );
    expect(trained.status).toBe(201);
    const refreshed = await fx.client.json<CharacterBody>(
      `/api/creator/characters/${trained.body.id}/refresh`,
      { method: "POST" },
    );
    expect(refreshed.body.status).toBe("COMPLETED");

    const patched = await fx.client.json<{ characterReferenceId: string | null }>(
      `/api/creator/folders/${fx.folderId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ characterReferenceId: trained.body.id }),
      },
    );
    expect(patched.status).toBe(200);
    expect(patched.body.characterReferenceId).toBe(trained.body.id);

    const created = await fx.client.json<{ generation: { id: string } }>(
      "/api/creator/generations",
      helpers.jsonBody({
        folderId: fx.folderId,
        modelId: model.id,
        rawPrompt: "Mbok Srini menyalakan lampu minyak",
        planMode: false,
        finalPrompt: null,
        attachmentKeys: [],
        contextIds: [],
        selectedParams: {
          resolution: model.allowedParams.resolutions[0],
          aspectRatio: model.allowedParams.aspectRatios[0],
        },
      }),
    );
    expect(created.status).toBe(201);
    await helpers.pollGeneration(fx.client, created.body.generation.id, ["COMPLETED", "FAILED"]);

    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({ custom_reference_id: "char-1" });
  });

  it("sends Deep Thinking to a Wan 3.0 workflow when the model enables it", async () => {
    const fx = await studioFixture("tuning-thinking@example.test");
    const model = await helpers.modelByCode("wan-qwen-10s");
    await db.update(aiModels).set({ thinkingEnabled: true }).where(eq(aiModels.id, model.id));

    const created = await fx.client.json<{ generation: { id: string } }>(
      "/api/creator/generations",
      helpers.jsonBody({
        folderId: fx.folderId,
        modelId: model.id,
        rawPrompt: "Lampu minyak",
        planMode: true,
        finalPrompt: "Slow cinematic lantern light",
        attachmentKeys: [],
        selectedParams: { durationSec: 10, resolution: "720p", aspectRatio: "16:9" },
      }),
    );
    expect(created.status).toBe(201);
    await helpers.pollGeneration(fx.client, created.body.generation.id, ["COMPLETED", "FAILED"]);

    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({ enable_thinking: true, duration: 10 });
  });

  it("sends the reference image to an image-to-video workflow", async () => {
    const fx = await studioFixture("tuning-i2v@example.test");
    const model = await helpers.modelByCode("wan-3.0-i2v");
    const attachment = await uploadPng(fx.client);

    const created = await fx.client.json<{ generation: { id: string } }>(
      "/api/creator/generations",
      helpers.jsonBody({
        folderId: fx.folderId,
        modelId: model.id,
        rawPrompt: "Dia menoleh ke kamera",
        planMode: true,
        finalPrompt: "She turns toward camera, lantern still in hand",
        attachmentKeys: [attachment.key],
        selectedParams: { durationSec: 5, resolution: "720p", aspectRatio: "16:9" },
      }),
    );
    expect(created.status).toBe(201);
    await helpers.pollGeneration(fx.client, created.body.generation.id, ["COMPLETED", "FAILED"]);

    expect(submissions).toHaveLength(1);
    const imageUrl = submissions[0]?.image_url;
    expect(typeof imageUrl).toBe("string");
    expect(String(imageUrl)).toContain("/media/");
  });
});

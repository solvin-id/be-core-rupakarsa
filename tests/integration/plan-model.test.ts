import { once } from "node:events";

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { encryptSecret } from "../../src/crypto/encryption.js";
import { db } from "../../src/db/client.js";
import { aiModels, aiProviders, generations, planUsages, workspaces } from "../../src/db/schema.js";
import { writeSetting, SETTING_KEYS } from "../../src/services/settings.js";
import {
  createAccount,
  createClient,
  createFolder,
  jsonBody,
  login,
  modelByCode,
  resetDatabase,
} from "./helpers.js";
import type { TestClient } from "./helpers.js";

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

interface ChatBody {
  model: string;
  messages: Array<{
    role: string;
    content: string | Array<{ type: string; text?: string; image_url?: { url: string }; video_url?: { url: string } }>;
  }>;
}

const captured: ChatBody[] = [];
let server: ReturnType<typeof serve> | null = null;
let baseUrl = "";

beforeAll(async () => {
  const app = new Hono();
  app.post("/v1/chat/completions", async (c) => {
    const body = (await c.req.json()) as ChatBody;
    captured.push(body);
    const system = typeof body.messages[0]?.content === "string" ? body.messages[0].content : "";
    const content = system.startsWith("Analyse the attached media")
      ? JSON.stringify({ subject: "MOCK SUBJECT", camera: "slow dolly", palette: "amber" })
      : JSON.stringify({
          prompt: `MOCK PROMPT for ${body.model}`,
          direction: "MOCK DIRECTION",
          negativePrompt: "MOCK NEGATIVE",
        });
    return c.json({
      choices: [{ message: { content } }],
      usage: { total_tokens: 12 },
    });
  });

  server = serve({ fetch: app.fetch, port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock provider did not bind");
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});

afterAll(async () => {
  server?.close();
});

interface Fixture {
  client: TestClient;
  workspaceId: string;
  folderId: string;
  visionId: string;
  imageOnlyId: string;
  textOnlyId: string;
  renderModelId: string;
}

function partKinds(body: ChatBody): string[] {
  const user = body.messages.find((message) => message.role === "user");
  if (!user || typeof user.content === "string") return [];
  return user.content.map((part) => part.type);
}

async function seedProviderModels(): Promise<{ visionId: string; imageOnlyId: string; textOnlyId: string }> {
  const [provider] = await db
    .insert(aiProviders)
    .values({
      code: "MOCK_AI",
      name: "Mock AI",
      baseUrl,
      apiKeyEncrypted: encryptSecret("mock-secret-key"),
      apiKeyMasked: "moc••••key",
      kind: "OPENAI_COMPATIBLE",
      modelsPath: "/models",
      isActive: true,
    })
    .returning();
  if (!provider) throw new Error("failed to create mock provider");

  const [vision] = await db
    .insert(aiModels)
    .values({
      providerId: provider.id,
      code: "vision",
      displayName: "Vision",
      providerModelId: "vision",
      mediaType: "IMAGE",
      inputCapabilities: ["TEXT", "IMAGE", "VIDEO"],
      outputCapabilities: ["TEXT", "IMAGE"],
      source: "MANUAL",
      allowedParams: { resolutions: ["1k"], aspectRatios: ["1:1"] },
      tokenCost: 2,
      isActive: true,
    })
    .returning();
  const [imageOnly] = await db
    .insert(aiModels)
    .values({
      providerId: provider.id,
      code: "image-only",
      displayName: "Image Only",
      providerModelId: "image-only",
      mediaType: "IMAGE",
      inputCapabilities: ["TEXT", "IMAGE"],
      outputCapabilities: ["TEXT"],
      source: "MANUAL",
      allowedParams: { resolutions: ["1k"], aspectRatios: ["1:1"] },
      tokenCost: 1,
      isActive: true,
    })
    .returning();
  const [textOnly] = await db
    .insert(aiModels)
    .values({
      providerId: provider.id,
      code: "text-only",
      displayName: "Text Only",
      providerModelId: "text-only",
      mediaType: "IMAGE",
      inputCapabilities: ["TEXT"],
      outputCapabilities: ["TEXT"],
      source: "MANUAL",
      allowedParams: { resolutions: ["1k"], aspectRatios: ["1:1"] },
      tokenCost: 1,
      isActive: true,
    })
    .returning();
  if (!vision || !imageOnly || !textOnly) throw new Error("failed to create mock models");

  return { visionId: vision.id, imageOnlyId: imageOnly.id, textOnlyId: textOnly.id };
}

async function configureAi(ids: { visionId: string; imageOnlyId: string; textOnlyId: string }, planModelId: string | null): Promise<void> {
  await writeSetting(db, SETTING_KEYS.ai, {
    planModelId,
    analysisModelId: ids.visionId,
    videoAnalysisModelId: ids.visionId,
    defaultVideoModelId: null,
  });
}

async function uploadPng(client: TestClient): Promise<{ key: string; id: string }> {
  const form = new FormData();
  form.append("file", new File([PNG_BYTES], "frame.png", { type: "image/png" }));
  const uploaded = await client.json<{ key: string }>("/api/creator/uploads", {
    method: "POST",
    body: form,
  });
  if (uploaded.status !== 201) throw new Error(`upload failed: ${JSON.stringify(uploaded.body)}`);
  return { key: uploaded.body.key, id: "" };
}

async function fixture(email: string, planModelId: "vision" | "image-only" | "text-only" | null): Promise<Fixture> {
  const account = await createAccount({ email });
  await db
    .update(workspaces)
    .set({ tokenBalance: 100, freePlanRemaining: 10 })
    .where(eq(workspaces.id, account.workspace.id));
  const client = createClient();
  await login(client, email);
  const folder = await createFolder(client, "Pipeline");
  const ids = await seedProviderModels();
  const chosen =
    planModelId === "vision"
      ? ids.visionId
      : planModelId === "image-only"
        ? ids.imageOnlyId
        : planModelId === "text-only"
          ? ids.textOnlyId
          : null;
  await configureAi(ids, chosen);
  const renderModel = await modelByCode("flux-image");

  return {
    client,
    workspaceId: account.workspace.id,
    folderId: folder.id,
    visionId: ids.visionId,
    imageOnlyId: ids.imageOnlyId,
    textOnlyId: ids.textOnlyId,
    renderModelId: renderModel.id,
  };
}

describe("plan model pipeline", () => {
  beforeEach(async () => {
    captured.length = 0;
    await resetDatabase();
  });

  it("runs the plan model with the attachment part when plan mode is ON", async () => {
    const fx = await fixture("plan-on@example.test", "vision");
    const attachment = await uploadPng(fx.client);

    const response = await fx.client.json<{
      blueprint: { prompt: string; direction: string; negativePrompt: string };
      analysis: { attachments: Array<{ key: string; text: string }>; preContext: string };
    }>("/api/creator/generations/plan", {
      ...jsonBody({
        folderId: fx.folderId,
        modelId: fx.renderModelId,
        rawPrompt: "Rempah di atas kain linen",
        resolution: "1k",
        aspectRatio: "1:1",
        attachmentKeys: [attachment.key],
      }),
    });

    expect(response.status).toBe(200);
    expect(response.body.blueprint.prompt).toContain("MOCK PROMPT for vision");
    expect(response.body.analysis.attachments).toHaveLength(1);
    expect(response.body.analysis.attachments[0]?.text).toContain("MOCK SUBJECT");

    const planCall = captured.find((body) => JSON.stringify(body).includes("You are a prompt engineer"));
    expect(planCall).toBeDefined();
    expect(partKinds(planCall as ChatBody)).toEqual(["text", "image_url"]);
  });

  it("rejects attachments the plan model cannot read", async () => {
    const fx = await fixture("plan-gate@example.test", "text-only");
    const attachment = await uploadPng(fx.client);

    const imageResponse = await fx.client.json<{ error: { message: string } }>(
      "/api/creator/generations/plan",
      jsonBody({
        folderId: fx.folderId,
        modelId: fx.renderModelId,
        rawPrompt: "Gambar",
        resolution: "1k",
        aspectRatio: "1:1",
        attachmentKeys: [attachment.key],
      }),
    );
    expect(imageResponse.status).toBe(400);
    expect(imageResponse.body.error.message).toBe(
      "Model plan tidak mendukung lampiran gambar. Pilih model plan lain atau hapus lampiran.",
    );
  });

  it("answers a direct-mode generation with the plan model output and no plan usage", async () => {
    const fx = await fixture("plan-direct@example.test", "vision");
    const attachment = await uploadPng(fx.client);

    const response = await fx.client.json<{ generation: { id: string } }>(
      "/api/creator/generations",
      jsonBody({
        folderId: fx.folderId,
        modelId: fx.renderModelId,
        rawPrompt: "Close-up rempah",
        planMode: false,
        finalPrompt: null,
        attachmentKeys: [attachment.key],
        selectedParams: { resolution: "1k", aspectRatio: "1:1" },
      }),
    );

    expect(response.status).toBe(201);
    const [row] = await db
      .select()
      .from(generations)
      .where(eq(generations.id, response.body.generation.id))
      .limit(1);
    expect(row?.finalPrompt).toBe("MOCK PROMPT for vision");
    expect(row?.plannedPrompt).toBe("MOCK PROMPT for vision");
    expect(row?.rawPrompt).toBe("Close-up rempah");
    expect(row?.analysisSnapshot.length).toBeGreaterThan(0);
    expect(row?.referenceImageUrl).toBe(attachment.key);

    const usage = await db.select().from(planUsages).where(eq(planUsages.workspaceId, fx.workspaceId));
    expect(usage).toHaveLength(0);
  });

  it("falls back to the deterministic blueprint without a plan model and ignores attachments", async () => {
    const fx = await fixture("plan-fallback@example.test", null);
    const attachment = await uploadPng(fx.client);

    const response = await fx.client.json<{
      blueprint: { prompt: string };
      analysis: { attachments: unknown[] };
    }>("/api/creator/generations/plan", {
      ...jsonBody({
        folderId: fx.folderId,
        modelId: fx.renderModelId,
        rawPrompt: "Uji fallback",
        resolution: "1k",
        aspectRatio: "1:1",
        attachmentKeys: [attachment.key],
      }),
    });

    expect(response.status).toBe(200);
    expect(response.body.blueprint.prompt).toContain("[SUBJECT] Uji fallback");
    expect(response.body.analysis.attachments).toHaveLength(0);
    expect(captured).toHaveLength(0);
  });

  it("exposes the plan model capabilities and default video model", async () => {
    const fx = await fixture("plan-config@example.test", "vision");
    const videoModel = await modelByCode("wan-qwen-5s");
    await writeSetting(db, SETTING_KEYS.ai, {
      planModelId: fx.visionId,
      analysisModelId: fx.visionId,
      videoAnalysisModelId: null,
      defaultVideoModelId: videoModel.id,
    });

    const config = await fx.client.json<{
      planModel: { id: string; name: string; inputCapabilities: string[] } | null;
      defaults: { videoModelId: string | null };
    }>("/api/public/config");

    expect(config.status).toBe(200);
    expect(config.body.planModel?.id).toBe(fx.visionId);
    expect(config.body.planModel?.name).toBe("Vision");
    expect(config.body.planModel?.inputCapabilities).toEqual(["TEXT", "IMAGE", "VIDEO"]);
    expect(config.body.defaults.videoModelId).toBe(videoModel.id);

    const models = await fx.client.json<Array<{ id: string; isDefault: boolean; mediaType: string }>>(
      "/api/creator/models",
    );
    const defaults = models.body.filter((row) => row.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]?.id).toBe(videoModel.id);
    expect(models.body.every((row) => row.mediaType === "VIDEO" || row.mediaType === "IMAGE")).toBe(true);
  });
});

import { once } from "node:events";

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { encryptSecret } from "../../src/crypto/encryption.js";
import { db } from "../../src/db/client.js";
import { aiModels, aiProviders, generations, workspaces } from "../../src/db/schema.js";
import { SETTING_KEYS, writeSetting } from "../../src/services/settings.js";
import {
  createAccount,
  createClient,
  createFolder,
  jsonBody,
  login,
  modelByCode,
  resetDatabase,
} from "./helpers.js";

interface ChatBody {
  model: string;
  messages: Array<{ role: string; content: string | Array<{ type: string }> }>;
}

const captured: ChatBody[] = [];
const COMPRESSED = "PADAT: subjek, aksi, kamera, cahaya, gaya.";
let server: ReturnType<typeof serve> | null = null;
let baseUrl = "";

beforeAll(async () => {
  const app = new Hono();
  app.post("/v1/chat/completions", async (c) => {
    const body = (await c.req.json()) as ChatBody;
    captured.push(body);
    const system = typeof body.messages[0]?.content === "string" ? body.messages[0].content : "";
    const content = system.startsWith("Compress the given production prompt")
      ? COMPRESSED
      : JSON.stringify({ prompt: "PLAN", direction: "DIR", negativePrompt: "NEG" });
    return c.json({ choices: [{ message: { content } }], usage: { total_tokens: 5 } });
  });

  server = serve({ fetch: app.fetch, port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock provider did not bind");
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});

afterAll(() => {
  server?.close();
});

async function adminClient() {
  const client = createClient();
  await login(client, process.env.SEED_SUPERADMIN_EMAIL ?? "admin@rupakarsa.id");
  return client;
}

async function planModelId(): Promise<string> {
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

  const [model] = await db
    .insert(aiModels)
    .values({
      providerId: provider.id,
      code: "planner",
      displayName: "Planner",
      providerModelId: "planner",
      mediaType: "IMAGE",
      inputCapabilities: ["TEXT"],
      outputCapabilities: ["TEXT"],
      source: "MANUAL",
      allowedParams: { resolutions: ["1k"], aspectRatios: ["1:1"] },
      tokenCost: 1,
      isActive: true,
    })
    .returning();
  if (!model) throw new Error("failed to create the plan model");
  return model.id;
}

async function fixture(email: string) {
  const account = await createAccount({ email });
  await db.update(workspaces).set({ tokenBalance: 100 }).where(eq(workspaces.id, account.workspace.id));
  const client = createClient();
  await login(client, email);
  const folder = await createFolder(client, "Limits");
  const renderModel = await modelByCode("flux-image");
  return { client, workspaceId: account.workspace.id, folderId: folder.id, renderModel };
}

function generationBody(input: {
  folderId: string;
  modelId: string;
  rawPrompt: string;
  finalPrompt: string | null;
  planMode: boolean;
}) {
  return jsonBody({
    folderId: input.folderId,
    modelId: input.modelId,
    rawPrompt: input.rawPrompt,
    planMode: input.planMode,
    finalPrompt: input.finalPrompt,
    attachmentKeys: [],
    selectedParams: { resolution: "1k", aspectRatio: "1:1" },
  });
}

describe("prompt limits and compression", () => {
  beforeEach(async () => {
    captured.length = 0;
    await resetDatabase();
  });

  it("saves the CMS limits and publishes them to the studio", async () => {
    const admin = await adminClient();

    const put = await admin.json<{ planPromptMaxChars: number; finalPromptMaxChars: number }>(
      "/api/cms/settings/limits",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          generationsPerDayPerWorkspace: 40,
          planRequestsPerHourPerUser: 30,
          planPromptMaxChars: 500,
          finalPromptMaxChars: 300,
        }),
      },
    );
    expect(put.status).toBe(200);
    expect(put.body.planPromptMaxChars).toBe(500);

    const read = await admin.json<{ planPromptMaxChars: number }>("/api/cms/settings/limits");
    expect(read.body.planPromptMaxChars).toBe(500);

    const config = await admin.json<{
      limits: { planPromptMaxChars: number; finalPromptMaxChars: number };
    }>("/api/public/config");
    expect(config.body.limits).toEqual({ planPromptMaxChars: 500, finalPromptMaxChars: 300 });
  });

  it("rejects a brief one character past the configured ceiling", async () => {
    const admin = await adminClient();
    await admin.request("/api/cms/settings/limits", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        generationsPerDayPerWorkspace: 50,
        planRequestsPerHourPerUser: 60,
        planPromptMaxChars: 500,
        finalPromptMaxChars: 300,
      }),
    });

    const fx = await fixture("limits-reject@example.test");
    const response = await fx.client.json<{ error: { message: string } }>(
      "/api/creator/generations",
      generationBody({
        folderId: fx.folderId,
        modelId: fx.renderModel.id,
        rawPrompt: "x".repeat(501),
        finalPrompt: null,
        planMode: false,
      }),
    );

    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe(
      "Brief maksimal 500 karakter dan tidak boleh kosong.",
    );
  });

  it("compresses an over-limit plan prompt through the plan model", async () => {
    const plannerId = await planModelId();
    await writeSetting(db, SETTING_KEYS.ai, {
      planModelId: plannerId,
      analysisModelId: null,
      videoAnalysisModelId: null,
      defaultVideoModelId: null,
    });

    const fx = await fixture("limits-compress@example.test");
    await db.update(aiModels).set({ maxPromptChars: 120 }).where(eq(aiModels.id, fx.renderModel.id));

    const response = await fx.client.json<{ generation: { id: string } }>(
      "/api/creator/generations",
      generationBody({
        folderId: fx.folderId,
        modelId: fx.renderModel.id,
        rawPrompt: "Brief pendek",
        finalPrompt: `[SUBJECT] ${"rempah ".repeat(60)}`,
        planMode: true,
      }),
    );
    expect(response.status).toBe(201);

    const [row] = await db
      .select()
      .from(generations)
      .where(eq(generations.id, response.body.generation.id))
      .limit(1);
    expect(row?.promptCompressed).toBe(true);
    expect(row?.promptLimitChars).toBe(120);
    expect(row?.finalPrompt).toBe(COMPRESSED);
    expect(row?.finalPrompt.length).toBeLessThanOrEqual(120);

    const compressCall = captured.find((body) =>
      JSON.stringify(body).includes("Compress the given production prompt"),
    );
    expect(compressCall).toBeDefined();
    expect(JSON.stringify(compressCall)).toContain("Limit: 120 characters");
  });

  it("truncates at a word boundary when no plan model is configured", async () => {
    await writeSetting(db, SETTING_KEYS.ai, {
      planModelId: null,
      analysisModelId: null,
      videoAnalysisModelId: null,
      defaultVideoModelId: null,
    });

    const fx = await fixture("limits-truncate@example.test");
    await db.update(aiModels).set({ maxPromptChars: 120 }).where(eq(aiModels.id, fx.renderModel.id));

    const longPrompt = `${"kata ".repeat(100)}akhir`;
    const response = await fx.client.json<{ generation: { id: string } }>(
      "/api/creator/generations",
      generationBody({
        folderId: fx.folderId,
        modelId: fx.renderModel.id,
        rawPrompt: "Brief pendek",
        finalPrompt: longPrompt,
        planMode: true,
      }),
    );
    expect(response.status).toBe(201);

    const [row] = await db
      .select()
      .from(generations)
      .where(eq(generations.id, response.body.generation.id))
      .limit(1);
    expect(row?.promptCompressed).toBe(true);
    expect(row?.promptLimitChars).toBe(120);
    expect(row?.finalPrompt.length).toBeLessThanOrEqual(120);
    expect(row?.finalPrompt.endsWith("kata")).toBe(true);
    expect(captured).toHaveLength(0);
  });
});

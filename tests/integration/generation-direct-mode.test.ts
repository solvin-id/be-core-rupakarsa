import { once } from "node:events";

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { encryptSecret } from "../../src/crypto/encryption.js";
import { db } from "../../src/db/client.js";
import { aiModels, aiProviders, generations, planUsages, workspaces } from "../../src/db/schema.js";
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
import type { TestClient } from "./helpers.js";

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

interface ChatBody {
  model: string;
  messages: Array<{ role: string; content: string | Array<{ type: string }> }>;
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
    return c.json({ choices: [{ message: { content } }], usage: { total_tokens: 12 } });
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

interface Fixture {
  client: TestClient;
  workspaceId: string;
  folderId: string;
  renderModelId: string;
  visionId: string;
}

async function seedAnalysisModel(): Promise<string> {
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
      outputCapabilities: ["TEXT"],
      source: "MANUAL",
      allowedParams: { resolutions: ["1k"], aspectRatios: ["1:1"] },
      tokenCost: 1,
      isActive: true,
    })
    .returning();
  if (!vision) throw new Error("failed to create the analysis model");
  return vision.id;
}

async function fixture(email: string, withPlanModel: boolean): Promise<Fixture> {
  const account = await createAccount({ email });
  await db.update(workspaces).set({ tokenBalance: 100 }).where(eq(workspaces.id, account.workspace.id));
  const client = createClient();
  await login(client, email);
  const folder = await createFolder(client, "Direct");

  const visionId = await seedAnalysisModel();
  await writeSetting(db, SETTING_KEYS.ai, {
    planModelId: withPlanModel ? visionId : null,
    analysisModelId: visionId,
    videoAnalysisModelId: visionId,
    defaultVideoModelId: null,
  });

  const contextResponse = await client.json<{ text: string }>(
    `/api/creator/folders/${folder.id}/contexts`,
    jsonBody({ source: "TEXT", label: "Naskah", text: "Aroma rempah dan kayu manis." }),
  );
  expect(contextResponse.status).toBe(201);

  const renderModel = await modelByCode("flux-image");
  return {
    client,
    workspaceId: account.workspace.id,
    folderId: folder.id,
    renderModelId: renderModel.id,
    visionId,
  };
}

async function uploadPng(client: TestClient): Promise<string> {
  const form = new FormData();
  form.append("file", new File([PNG_BYTES], "frame.png", { type: "image/png" }));
  const uploaded = await client.json<{ key: string }>("/api/creator/uploads", {
    method: "POST",
    body: form,
  });
  if (uploaded.status !== 201) throw new Error(`upload failed: ${JSON.stringify(uploaded.body)}`);
  return uploaded.body.key;
}

async function generate(fixtureValue: Fixture, rawPrompt: string, attachmentKey: string | null) {
  return fixtureValue.client.json<{ generation: { id: string } }>(
    "/api/creator/generations",
    jsonBody({
      folderId: fixtureValue.folderId,
      modelId: fixtureValue.renderModelId,
      rawPrompt,
      planMode: false,
      finalPrompt: null,
      attachmentKeys: attachmentKey ? [attachmentKey] : [],
      selectedParams: { resolution: "1k", aspectRatio: "1:1" },
    }),
  );
}

describe("direct mode without a plan model call", () => {
  beforeEach(async () => {
    captured.length = 0;
    await resetDatabase();
  });

  it("composes a structured prompt from the brief, the attachments and the pre-context", async () => {
    const fx = await fixture("direct-mode@example.test", false);
    const attachmentKey = await uploadPng(fx.client);

    const response = await generate(fx, "Close-up rempah di kain linen", attachmentKey);
    expect(response.status).toBe(201);

    const [row] = await db
      .select()
      .from(generations)
      .where(eq(generations.id, response.body.generation.id))
      .limit(1);

    // The deterministic blueprint carries the brief as the subject, not as a raw appended block.
    expect(row?.finalPrompt).toContain("[SUBJECT] Close-up rempah di kain linen");
    expect(row?.finalPrompt).toContain("[ATTACHMENT NOTES]\n#1 ");
    expect(row?.finalPrompt).toContain("[STYLE ANCHORS]");
    expect(row?.finalPrompt).toContain("Aroma rempah");
    expect(row?.finalPrompt).not.toContain("[MODE]");
    expect(row?.finalPrompt).toContain("MOCK SUBJECT");
    expect(row?.plannedPrompt).toBe(row?.finalPrompt);
    expect(row?.referenceImageUrl).toBe(attachmentKey);

    // The analysis model ran; the plan model never did.
    expect(
      captured.some((body) =>
        JSON.stringify(body).includes("You are a prompt engineer"),
      ),
    ).toBe(false);
    expect(
      captured.some((body) => JSON.stringify(body).includes("Analyse the attached media")),
    ).toBe(true);

    const usage = await db.select().from(planUsages).where(eq(planUsages.workspaceId, fx.workspaceId));
    expect(usage).toHaveLength(0);
  });

  it("uses the plan model immediately when it is configured and plan mode is off", async () => {
    const fx = await fixture("direct-mode-with-plan@example.test", true);
    const attachmentKey = await uploadPng(fx.client);

    const response = await generate(fx, "Gerobak sate di senja", attachmentKey);
    expect(response.status).toBe(201);

    const [row] = await db
      .select()
      .from(generations)
      .where(eq(generations.id, response.body.generation.id))
      .limit(1);

    // Direct mode runs the same plan model as plan mode, minus the review step and plan quota.
    expect(row?.finalPrompt).toBe("MOCK PROMPT for vision");
    expect(row?.promptCompressed).toBe(false);
    const usage = await db.select().from(planUsages).where(eq(planUsages.workspaceId, fx.workspaceId));
    expect(usage).toHaveLength(0);
  });

  it("rejects an attachment when no analysis model is configured", async () => {
    const fx = await fixture("direct-mode-no-analysis@example.test", false);
    await writeSetting(db, SETTING_KEYS.ai, {
      planModelId: null,
      analysisModelId: null,
      videoAnalysisModelId: null,
      defaultVideoModelId: null,
    });
    const attachmentKey = await uploadPng(fx.client);

    const response = await generate(fx, "Lampu minyak", attachmentKey);
    expect(response.status).toBe(409);
    expect(JSON.stringify(response.body)).toContain("Model analisis belum dikonfigurasi");
  });
});

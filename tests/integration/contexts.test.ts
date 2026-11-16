import { once } from "node:events";

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { encryptSecret } from "../../src/crypto/encryption.js";
import { db } from "../../src/db/client.js";
import { aiModels, aiProviders, generations, mediaAssets, workspaces } from "../../src/db/schema.js";
import { SETTING_KEYS, writeSetting } from "../../src/services/settings.js";
import {
  createAccount,
  createClient,
  createFolder,
  jsonBody,
  login,
  modelByCode,
  pollGeneration,
  resetDatabase,
} from "./helpers.js";
import type { TestClient } from "./helpers.js";

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let server: ReturnType<typeof serve> | null = null;
let baseUrl = "";

beforeAll(async () => {
  const app = new Hono();
  app.post("/v1/chat/completions", (c) =>
    c.json({
      choices: [
        {
          message: {
            content: JSON.stringify({ subject: "ANALYSED SUBJECT", camera: "slow dolly", palette: "amber" }),
          },
        },
      ],
      usage: { total_tokens: 8 },
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

interface Fixture {
  client: TestClient;
  folderId: string;
  workspaceId: string;
  mediaAssetId: string;
  mediaKey: string;
}

async function fixture(email: string): Promise<Fixture> {
  const account = await createAccount({ email });
  await db
    .update(workspaces)
    .set({ tokenBalance: 200, freePlanRemaining: 5 })
    .where(eq(workspaces.id, account.workspace.id));
  const client = createClient();
  await login(client, email);
  const folder = await createFolder(client, "Konteks");

  const [provider] = await db
    .insert(aiProviders)
    .values({
      code: "MOCK_CTX",
      name: "Mock Context",
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
      code: "vision-ctx",
      displayName: "Vision Context",
      providerModelId: "vision-ctx",
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

  await writeSetting(db, SETTING_KEYS.ai, {
    planModelId: null,
    analysisModelId: vision.id,
    videoAnalysisModelId: vision.id,
    defaultVideoModelId: null,
  });

  const form = new FormData();
  form.append("file", new File([PNG_BYTES], "referensi.png", { type: "image/png" }));
  const uploaded = await client.json<{ key: string; url: string }>("/api/creator/uploads", {
    method: "POST",
    body: form,
  });
  if (uploaded.status !== 201) throw new Error(`upload failed: ${JSON.stringify(uploaded.body)}`);

  const assetIdOf = await db
    .select({ id: mediaAssets.id })
    .from(mediaAssets)
    .where(eq(mediaAssets.key, uploaded.body.key))
    .limit(1);
  const assetId = assetIdOf[0]?.id ?? "";
  if (!assetId) throw new Error("uploaded asset missing from media_assets");

  return {
    client,
    folderId: folder.id,
    workspaceId: account.workspace.id,
    mediaAssetId: assetId,
    mediaKey: uploaded.body.key,
  };
}

describe("project pre-context", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("collects text and analysed generations into the generation snapshot", async () => {
    const fx = await fixture("context@example.test");
    const renderModel = await modelByCode("flux-image");

    const text = await fx.client.json<{ id: string; label: string }>(
      `/api/creator/folders/${fx.folderId}/contexts`,
      jsonBody({ source: "TEXT", label: "Brand", text: "Brand voice: hangat dan membumi." }),
    );
    expect(text.status).toBe(201);

    const upload = await fx.client.json<{ id: string; text: string; source: string }>(
      `/api/creator/folders/${fx.folderId}/contexts`,
      jsonBody({ source: "UPLOAD", label: "Referensi", mediaAssetId: fx.mediaAssetId }),
    );
    expect(upload.status).toBe(201);
    expect(upload.body.text).toContain("ANALYSED SUBJECT");

    const created = await fx.client.json<{ generation: { id: string } }>(
      "/api/creator/generations",
      jsonBody({
        folderId: fx.folderId,
        modelId: renderModel.id,
        rawPrompt: "Still life rempah",
        planMode: false,
        finalPrompt: "Editorial still life",
        contextIds: [],
        selectedParams: { resolution: "1k", aspectRatio: "1:1" },
      }),
    );
    expect(created.status).toBe(201);

    const [row] = await db
      .select()
      .from(generations)
      .where(eq(generations.id, created.body.generation.id))
      .limit(1);
    expect(row?.preContextSnapshot).toContain("[Brand] Brand voice: hangat dan membumi.");
    expect(row?.preContextSnapshot).toContain("[Referensi] ");
    expect(row?.preContextSnapshot).toContain("ANALYSED SUBJECT");

    const finished = await pollGeneration(fx.client, created.body.generation.id, [
      "COMPLETED",
      "FAILED",
    ]);
    expect(finished.status).toBe("COMPLETED");

    const fromHistory = await fx.client.json<{ id: string; text: string; generationId: string | null }>(
      `/api/creator/folders/${fx.folderId}/contexts`,
      jsonBody({ source: "GENERATION", generationId: created.body.generation.id }),
    );
    expect(fromHistory.status).toBe(201);
    expect(fromHistory.body.generationId).toBe(created.body.generation.id);
    expect(fromHistory.body.text).toContain("ANALYSED SUBJECT");

    const listed = await fx.client.json<Array<{ id: string }>>(
      `/api/creator/folders/${fx.folderId}/contexts`,
    );
    expect(listed.body).toHaveLength(3);

    const toggled = await fx.client.json<{ isActive: boolean }>(
      `/api/creator/contexts/${text.body.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isActive: false }),
      },
    );
    expect(toggled.status).toBe(200);
    expect(toggled.body.isActive).toBe(false);

    const removed = await fx.client.request(`/api/creator/contexts/${text.body.id}`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(204);
  });
});

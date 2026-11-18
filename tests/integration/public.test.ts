import { beforeEach, describe, expect, it } from "vitest";

import { db } from "../../src/db/client.js";
import { aiModels, aiProviders } from "../../src/db/schema.js";
import { createRedisConnection } from "../../src/queue/generation-queue.js";
import { createClient, jsonBody, login, resetDatabase } from "./helpers.js";

describe("public endpoints", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("exposes the platform config used by both frontends", async () => {
    const client = createClient();
    const response = await client.json<{
      contact: { name: string; whatsapp: string; email: string };
      pricing: {
        tokenValueRupiah: number;
        packageTokens: number;
        packagePlanQuota: number;
        planModeTokenCost: number;
      };
      features: { simulation: boolean };
      planModel: unknown;
      analysisModels: { image: unknown; video: unknown };
    }>("/api/public/config");

    expect(response.status).toBe(200);
    expect(response.body.planModel).toBeNull();
    expect(response.body.analysisModels).toEqual({ image: null, video: null });
    expect(response.body.contact).toEqual({
      name: "Tim Rupakarsa",
      whatsapp: "",
      email: "halo@rupakarsa.id",
    });
    expect(response.body.pricing).toEqual({
      tokenValueRupiah: 500,
      packageTokens: 4000,
      packagePlanQuota: 250,
      planModeTokenCost: 1,
    });
    expect(response.body.features.simulation).toBe(true);
  });

  it("publishes the wired analysis models so the studio can gate media inputs", async () => {
    const [provider] = await db
      .insert(aiProviders)
      .values({
        code: "VISION_AI",
        name: "Vision AI",
        baseUrl: "https://vision.example.test/v1",
        kind: "OPENAI_COMPATIBLE",
        modelsPath: "/models",
        isActive: true,
      })
      .returning();
    if (!provider) throw new Error("failed to create the analysis provider");

    const [videoModel] = await db
      .insert(aiModels)
      .values({
        providerId: provider.id,
        code: "vision-video",
        displayName: "Vision Video",
        providerModelId: "vision-video",
        mediaType: "VIDEO",
        inputCapabilities: ["TEXT", "VIDEO"],
        outputCapabilities: ["TEXT"],
        source: "MANUAL",
        allowedParams: { resolutions: [], aspectRatios: [] },
        tokenCost: 1,
        isActive: true,
      })
      .returning();
    if (!videoModel) throw new Error("failed to create the video analysis model");

    const admin = createClient();
    await login(admin, process.env.SEED_SUPERADMIN_EMAIL ?? "admin@rupakarsa.id");
    const saved = await admin.json<{ videoAnalysisModelId: string | null }>(
      "/api/cms/settings/ai",
      {
        ...jsonBody({
          planModelId: null,
          analysisModelId: null,
          videoAnalysisModelId: videoModel.id,
          defaultVideoModelId: null,
        }),
        method: "PUT",
      },
    );
    expect(saved.status).toBe(200);

    const config = await createClient().json<{
      planModel: unknown;
      analysisModels: {
        image: { id: string; name: string; inputCapabilities: string[] } | null;
        video: { id: string; name: string; inputCapabilities: string[] } | null;
      };
    }>("/api/public/config");

    expect(config.status).toBe(200);
    // The plan model is still unset: configuring analysis must be enough for media analysis.
    expect(config.body.planModel).toBeNull();
    expect(config.body.analysisModels.image).toBeNull();
    expect(config.body.analysisModels.video).toEqual({
      id: videoModel.id,
      name: "Vision Video",
      inputCapabilities: ["TEXT", "VIDEO"],
    });
  });

  it("reports database, redis, and worker health", async () => {
    const redis = createRedisConnection();
    await redis.set("rupakarsa:worker:heartbeat", String(Date.now()), "EX", 30);
    await redis.quit();

    const client = createClient();
    const response = await client.json<{ status: string; db: boolean }>("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok", db: true, redis: true, worker: true });
  });

  it("returns the API error envelope for unknown routes", async () => {
    const client = createClient();
    const response = await client.json<{ error: { code: string; message: string } }>("/api/tidak-ada");

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });
});

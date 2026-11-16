import { beforeEach, describe, expect, it } from "vitest";

import { createRedisConnection } from "../../src/queue/generation-queue.js";
import { createClient, resetDatabase } from "./helpers.js";

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
    }>("/api/public/config");

    expect(response.status).toBe(200);
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

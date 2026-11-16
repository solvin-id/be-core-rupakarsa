import { beforeEach, describe, expect, it } from "vitest";

import { createRedisConnection } from "../../src/queue/generation-queue.js";
import { SETTING_KEYS, writeSetting } from "../../src/services/settings.js";
import { db } from "../../src/db/client.js";
import {
  createAccount,
  createClient,
  createFolder,
  jsonBody,
  login,
  modelByCode,
  resetDatabase,
} from "./helpers.js";

describe("hardening", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("rejects cookie mutations without the CSRF header", async () => {
    const account = await createAccount({ email: "csrf@example.test" });
    await db.execute(
      `update workspaces set token_balance = 100 where id = '${account.workspace.id}'`,
    );
    const client = createClient();
    await login(client, "csrf@example.test");
    const folder = await createFolder(client, "CSRF");

    const withoutHeader = await client.json<{ error: { message: string } }>(
      "/api/creator/generations/plan",
      {
        ...jsonBody({
          folderId: folder.id,
          modelId: (await modelByCode("wan-qwen-5s")).id,
          rawPrompt: "Uji CSRF",
          durationSec: 5,
          resolution: "1080p",
          aspectRatio: "16:9",
        }),
        headers: { "content-type": "application/json", "x-csrf-token": "" },
      },
    );
    expect(withoutHeader.status).toBe(403);
    expect(withoutHeader.body.error.message).toBe("Token CSRF tidak valid. Muat ulang halaman.");

    const withHeader = await client.json<{ blueprint: { prompt: string } }>(
      "/api/creator/generations/plan",
      jsonBody({
        folderId: folder.id,
        modelId: (await modelByCode("wan-qwen-5s")).id,
        rawPrompt: "Uji CSRF",
        durationSec: 5,
        resolution: "1080p",
        aspectRatio: "16:9",
      }),
    );
    expect(withHeader.status).toBe(200);
  });

  it("enforces the workspace daily generation quota", async () => {
    const account = await createAccount({ email: "quota@example.test" });
    await db.execute(
      `update workspaces set token_balance = 100 where id = '${account.workspace.id}'`,
    );
    await writeSetting(db, SETTING_KEYS.limits, {
      generationsPerDayPerWorkspace: 1,
      planRequestsPerHourPerUser: 60,
    });

    const client = createClient();
    await login(client, "quota@example.test");
    const folder = await createFolder(client, "Kuota");
    const model = await modelByCode("flux-image");

    const first = await client.json<{ generation: { id: string } }>(
      "/api/creator/generations",
      jsonBody({
        folderId: folder.id,
        modelId: model.id,
        rawPrompt: "Satu",
        planMode: false,
        finalPrompt: "Satu",
        selectedParams: { resolution: "1k", aspectRatio: "1:1" },
      }),
    );
    expect(first.status).toBe(201);

    const second = await client.json<{ error: { message: string } }>(
      "/api/creator/generations",
      jsonBody({
        folderId: folder.id,
        modelId: model.id,
        rawPrompt: "Dua",
        planMode: false,
        finalPrompt: "Dua",
        selectedParams: { resolution: "1k", aspectRatio: "1:1" },
      }),
    );
    expect(second.status).toBe(409);
    expect(second.body.error.message).toBe("Kuota generasi harian workspace ini sudah habis.");
  });

  it("reports a degraded health when the worker heartbeat is stale", async () => {
    const redis = createRedisConnection();
    await redis.del("rupakarsa:worker:heartbeat");
    await redis.quit();

    const client = createClient();
    const response = await client.json<{ status: string; db: boolean; redis: boolean; worker: boolean }>(
      "/health",
    );
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: "degraded", db: true, redis: true, worker: false });
  });
});

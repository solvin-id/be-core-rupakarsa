import { setTimeout as delay } from "node:timers/promises";

import { eq } from "drizzle-orm";
import type { Redis } from "ioredis";

import { db } from "../db/client.js";
import { aiModels, aiProviders, generations, mediaAssets } from "../db/schema.js";
import type { RenderResult } from "../adapters/types.js";
import { logger } from "../logger.js";
import { createRedisConnection } from "../queue/generation-queue.js";
import type { RenderJob } from "../queue/index.js";
import { getRenderAdapter } from "../providers/registry.js";
import { renderDuration, renderTotal, tokensCharged } from "../routes/metrics.js";
import { failGeneration, finalizeGeneration } from "../services/generation-service.js";
import { urlForAsset } from "../services/storage-service.js";

const RENDER_TIMEOUT_MS = 120_000;
const FALLBACK_ERROR = "Render gagal. Token dikembalikan otomatis.";
const PROVIDER_SLOT_LIMIT = 4;
const SLOT_WAIT_MS = 500;
const SLOT_WAIT_ATTEMPTS = 60;

let slotConnection: Redis | null = null;

function slotRedis(): Redis {
  if (!slotConnection) slotConnection = createRedisConnection();
  return slotConnection;
}

/**
 * Soft per-provider concurrency gate shared through Redis. A saturated provider makes the job wait
 * instead of failing, so nothing is refunded and no work is lost.
 */
async function withProviderSlot<T>(providerId: string, run: () => Promise<T>): Promise<T> {
  const key = `rupakarsa:provider:inflight:${providerId}`;
  const redis = slotRedis();

  for (let attempt = 0; attempt < SLOT_WAIT_ATTEMPTS; attempt += 1) {
    const value = await redis.incr(key);
    if (value <= PROVIDER_SLOT_LIMIT) {
      try {
        return await run();
      } finally {
        await redis.decr(key);
      }
    }
    await redis.decr(key);
    await delay(SLOT_WAIT_MS);
  }

  logger.warn({ providerId }, "provider slot wait exhausted; rendering anyway");
  const value = await redis.incr(key);
  try {
    void value;
    return await run();
  } finally {
    await redis.decr(key);
  }
}

async function referenceUrlFor(key: string | null): Promise<string | null> {
  if (!key) return null;
  const [asset] = await db.select().from(mediaAssets).where(eq(mediaAssets.key, key)).limit(1);
  if (!asset) return null;
  return urlForAsset(asset);
}

async function resolveProviderLabel(modelId: string | null): Promise<{ id: string; name: string }> {
  if (!modelId) return { id: "unknown", name: "unknown" };
  const [row] = await db
    .select({ id: aiProviders.id, name: aiProviders.name })
    .from(aiModels)
    .innerJoin(aiProviders, eq(aiProviders.id, aiModels.providerId))
    .where(eq(aiModels.id, modelId))
    .limit(1);
  return row ?? { id: modelId, name: "unknown" };
}

export async function renderGeneration(job: RenderJob): Promise<void> {
  const [generation] = await db
    .select()
    .from(generations)
    .where(eq(generations.id, job.generationId))
    .limit(1);

  if (!generation) return;
  if (generation.status === "COMPLETED" || generation.status === "FAILED") return;

  await db
    .update(generations)
    .set({ status: "RENDERING" })
    .where(eq(generations.id, generation.id));

  const provider = await resolveProviderLabel(generation.modelId);
  const startedAt = Date.now();

  try {
    if (!generation.modelId) {
      throw new Error("Model render tidak ditemukan pada generation ini.");
    }
    const adapter = await getRenderAdapter(generation.modelId);
    const result = await withProviderSlot(provider.id, async () =>
      adapter.render(
        {
          generationId: generation.id,
          prompt: generation.finalPrompt || generation.plannedPrompt || generation.rawPrompt,
          mediaType: generation.mediaType,
          modelName: generation.modelName,
          selectedParams: generation.selectedParams,
          simulateFailure: job.simulateFailure,
          referenceUrl: await referenceUrlFor(generation.referenceImageUrl),
        },
        AbortSignal.timeout(RENDER_TIMEOUT_MS),
      ),
    );
    await finalizeGeneration(generation.id, result as RenderResult);

    renderTotal.inc({ status: "completed", provider: provider.name });
    renderDuration.observe({ provider: provider.name }, (Date.now() - startedAt) / 1000);
    tokensCharged.inc({ provider: provider.name }, generation.tokensCharged);
  } catch (error) {
    const message = error instanceof Error && error.message.length > 0 ? error.message : FALLBACK_ERROR;
    await failGeneration(generation.id, message);
    renderTotal.inc({ status: "failed", provider: provider.name });
    renderDuration.observe({ provider: provider.name }, (Date.now() - startedAt) / 1000);
  }
}

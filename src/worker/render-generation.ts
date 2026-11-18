import { setTimeout as delay } from "node:timers/promises";

import { eq } from "drizzle-orm";
import type { Redis } from "ioredis";

import { db } from "../db/client.js";
import { aiModels, aiProviders, generations, mediaAssets } from "../db/schema.js";
import { supportsVideoAdapter } from "../adapters/types.js";
import type { RenderRequest, RenderResult, VideoRenderAdapter } from "../adapters/types.js";
import { waitFor } from "../adapters/wait-for.js";
import { AppError } from "../http/errors.js";
import { logger } from "../logger.js";
import { createRedisConnection } from "../queue/generation-queue.js";
import type { RenderJob } from "../queue/index.js";
import { getRenderAdapter } from "../providers/registry.js";
import { renderDuration, renderTotal, tokensCharged } from "../routes/metrics.js";
import { logAiActivity } from "../services/ai-activity-log.js";
import {
  failGeneration,
  finalizeGeneration,
  markGenerationStarted,
  markProviderStatus,
} from "../services/generation-service.js";
import { urlForAsset } from "../services/storage-service.js";

const IMAGE_RENDER_TIMEOUT_MS = 120_000;
/** kenari closes an unfinished video job after an hour, so 20 minutes still leaves room to fail cleanly. */
const VIDEO_RENDER_TIMEOUT_MS = 20 * 60_000;
const VIDEO_POLL_INTERVAL_MS = 5_000;
/** An image job finishes in seconds, so a slow 5 s poll would waste most of its budget. */
const IMAGE_POLL_INTERVAL_MS = 2_000;
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

/** Shared context every render event of this job logs with. */
interface JobScope {
  generationId: string;
  workspaceId: string;
  userId: string | null;
  folderId: string;
  modelId: string | null;
  modelName: string;
  mediaType: "VIDEO" | "IMAGE";
  providerId: string;
  providerName: string;
  endpoint: string;
}

export async function renderGeneration(job: RenderJob): Promise<void> {
  const [generation] = await db
    .select()
    .from(generations)
    .where(eq(generations.id, job.generationId))
    .limit(1);

  if (!generation) return;
  if (generation.status === "COMPLETED" || generation.status === "FAILED") return;

  await markGenerationStarted(generation.id);

  const provider = await resolveProviderLabel(generation.modelId);
  const startedAt = Date.now();

  try {
    if (!generation.modelId) {
      throw new Error("Model render tidak ditemukan pada generation ini.");
    }
    const adapter = await getRenderAdapter(generation.modelId);
    const referenceUrl = await referenceUrlFor(generation.referenceImageUrl);
    const request: RenderRequest = {
      generationId: generation.id,
      prompt: generation.finalPrompt || generation.plannedPrompt || generation.rawPrompt,
      mediaType: generation.mediaType,
      modelName: generation.modelName,
      selectedParams: generation.selectedParams,
      simulateFailure: job.simulateFailure,
      referenceImages: referenceUrl ? [referenceUrl] : [],
      referenceVideos: [],
    };
    const signal = AbortSignal.timeout(
      request.mediaType === "VIDEO" ? VIDEO_RENDER_TIMEOUT_MS : IMAGE_RENDER_TIMEOUT_MS,
    );
    const scope: JobScope = {
      generationId: generation.id,
      workspaceId: generation.workspaceId,
      userId: generation.userId,
      folderId: generation.folderId,
      modelId: generation.modelId,
      modelName: generation.modelName,
      mediaType: generation.mediaType,
      providerId: provider.id,
      providerName: provider.name,
      endpoint: "async-job",
    };

    // Video always uses the job contract; images use it only when the provider advertises it
    // (Higgsfield's SOUL renders), while OpenAI-compatible images stay a single request.
    const useJobFlow =
      supportsVideoAdapter(adapter) && (request.mediaType === "VIDEO" || adapter.supportsImageJobs);
    const result = useJobFlow
      ? await renderJob(adapter, request, signal, scope, startedAt)
      : await withProviderSlot(provider.id, () => adapter.render(request, signal));
    await finalizeGeneration(generation.id, result);

    await logAiActivity({
      kind: "RENDER_COMPLETE",
      status: "SUCCESS",
      workspaceId: generation.workspaceId,
      userId: generation.userId,
      folderId: generation.folderId,
      generationId: generation.id,
      providerId: provider.id,
      modelId: generation.modelId,
      modelName: generation.modelName,
      mediaType: generation.mediaType,
      latencyMs: Date.now() - startedAt,
      externalJobId: result.externalJobId,
      metadata: { bytes: result.bytes.byteLength, mime: result.mime },
    });

    renderTotal.inc({ status: "completed", provider: provider.name });
    renderDuration.observe({ provider: provider.name }, (Date.now() - startedAt) / 1000);
    tokensCharged.inc({ provider: provider.name }, generation.tokensCharged);
  } catch (error) {
    const message = error instanceof Error && error.message.length > 0 ? error.message : FALLBACK_ERROR;
    await failGeneration(generation.id, message);
    await logAiActivity({
      kind: "RENDER_FAIL",
      status: "ERROR",
      workspaceId: generation.workspaceId,
      userId: generation.userId,
      folderId: generation.folderId,
      generationId: generation.id,
      providerId: provider.id,
      modelId: generation.modelId,
      modelName: generation.modelName,
      mediaType: generation.mediaType,
      latencyMs: Date.now() - startedAt,
      errorCode: error instanceof AppError ? error.code : "RENDER_FAILED",
      errorMessage: message,
    });
    renderTotal.inc({ status: "failed", provider: provider.name });
    renderDuration.observe({ provider: provider.name }, (Date.now() - startedAt) / 1000);
  }
}

/**
 * Async provider jobs: submit and download hold a provider slot, polling does not, so a long render
 * cannot starve the four-slot gate for other work on the same provider.
 */
async function renderJob(
  adapter: VideoRenderAdapter,
  input: RenderRequest,
  signal: AbortSignal,
  scope: JobScope,
  startedAt: number,
): Promise<RenderResult> {
  let jobId: string;
  try {
    const submitted = await withProviderSlot(scope.providerId, () =>
      adapter.submitVideo(input, signal),
    );
    jobId = submitted.jobId;
    await logAiActivity({
      kind: "RENDER_SUBMIT",
      status: "SUCCESS",
      workspaceId: scope.workspaceId,
      userId: scope.userId,
      folderId: scope.folderId,
      generationId: scope.generationId,
      providerId: scope.providerId,
      modelId: scope.modelId,
      modelName: scope.modelName,
      mediaType: scope.mediaType,
      latencyMs: Date.now() - startedAt,
      externalJobId: jobId,
      promptChars: input.prompt.length,
      requestText: input.prompt,
      metadata: {
        mediaType: scope.mediaType,
        endpoint: scope.endpoint,
        providerName: scope.providerName,
      },
    });
  } catch (error) {
    await logAiActivity({
      kind: "RENDER_SUBMIT",
      status: "ERROR",
      workspaceId: scope.workspaceId,
      userId: scope.userId,
      folderId: scope.folderId,
      generationId: scope.generationId,
      providerId: scope.providerId,
      modelId: scope.modelId,
      modelName: scope.modelName,
      mediaType: scope.mediaType,
      latencyMs: Date.now() - startedAt,
      promptChars: input.prompt.length,
      requestText: input.prompt,
      errorCode: error instanceof AppError ? error.code : "SUBMIT_FAILED",
      errorMessage: error instanceof Error ? error.message : "Pengiriman job gagal.",
      metadata: { mediaType: scope.mediaType, endpoint: scope.endpoint },
    });
    throw error;
  }

  const pollIntervalMs =
    input.mediaType === "VIDEO" ? VIDEO_POLL_INTERVAL_MS : IMAGE_POLL_INTERVAL_MS;

  let url: string | null = null;
  let lastStatus = "";
  while (url === null) {
    await waitFor(pollIntervalMs, signal);
    const status = await adapter.pollVideo(jobId, signal);
    if (status.state === "failed") throw new AppError(502, "PROVIDER_ERROR", status.reason);
    if (status.state === "done") {
      url = status.url;
      break;
    }
    // Only the provider's own state is surfaced; there is no percentage to invent.
    if (status.providerStatus && status.providerStatus !== lastStatus) {
      lastStatus = status.providerStatus;
      const changed = await markProviderStatus(input.generationId, lastStatus);
      if (changed) {
        await logAiActivity({
          kind: "RENDER_STATUS",
          status: "PENDING",
          workspaceId: scope.workspaceId,
          userId: scope.userId,
          folderId: scope.folderId,
          generationId: scope.generationId,
          providerId: scope.providerId,
          modelId: scope.modelId,
          modelName: scope.modelName,
          mediaType: scope.mediaType,
          latencyMs: Date.now() - startedAt,
          externalJobId: jobId,
          metadata: { providerStatus: lastStatus },
        });
      }
    }
  }

  const clip = await withProviderSlot(scope.providerId, () => adapter.downloadVideo(url, signal));
  return {
    bytes: clip.bytes,
    mime: clip.mime,
    externalJobId: jobId,
    durationSec: input.selectedParams.durationSec,
  };
}

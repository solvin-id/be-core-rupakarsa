import { eq } from "drizzle-orm";

import { HiggsfieldRenderAdapter } from "../adapters/higgsfield-render.js";
import { OpenAiCompatibleAdapter } from "../adapters/openai-compatible.js";
import { StubRenderAdapter } from "../adapters/stub-render.js";
import type { RenderAdapter } from "../adapters/types.js";
import { db } from "../db/client.js";
import { aiModels, aiProviders } from "../db/schema.js";
import type { AiModelRow, AiProviderRow, ModelCapability } from "../db/schema.js";
import { env } from "../env.js";
import { AppError, conflict, notFound, validation } from "../http/errors.js";
import { getAiSettings } from "../services/settings.js";

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { value: RenderAdapter; expiresAt: number }>();

function cached(key: string): RenderAdapter | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function remember(key: string, value: RenderAdapter): RenderAdapter {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

export function clearAdapterCache(): void {
  cache.clear();
}

async function loadModel(modelId: string): Promise<{ model: AiModelRow; provider: AiProviderRow }> {
  const [model] = await db.select().from(aiModels).where(eq(aiModels.id, modelId)).limit(1);
  if (!model) throw notFound("Model tidak ditemukan.");
  if (!model.isActive) throw conflict("Model ini sedang tidak aktif.");

  const [provider] = await db
    .select()
    .from(aiProviders)
    .where(eq(aiProviders.id, model.providerId))
    .limit(1);
  if (!provider) throw notFound("Provider model ini tidak ditemukan.");
  if (!provider.isActive) throw conflict("Provider model ini sedang tidak aktif.");

  return { model, provider };
}

/** Stub mode keeps tests and local development offline; live mode picks the provider adapter. */
export async function getRenderAdapter(modelId: string): Promise<RenderAdapter> {
  if (env.PROVIDER_MODE === "stub") return new StubRenderAdapter();

  const key = `render:${modelId}`;
  const hit = cached(key);
  if (hit) return hit;

  const { model, provider } = await loadModel(modelId);
  const adapter: RenderAdapter =
    provider.kind === "HIGGSFIELD"
      ? new HiggsfieldRenderAdapter(provider, model)
      : new OpenAiCompatibleAdapter(provider, model);

  return remember(key, adapter);
}

async function loadConfiguredModel(
  modelId: string | null,
): Promise<{ model: AiModelRow; provider: AiProviderRow } | null> {
  if (!modelId) return null;
  const [model] = await db.select().from(aiModels).where(eq(aiModels.id, modelId)).limit(1);
  if (!model || !model.isActive) return null;

  const [provider] = await db
    .select()
    .from(aiProviders)
    .where(eq(aiProviders.id, model.providerId))
    .limit(1);
  if (!provider || !provider.isActive) return null;

  return { model, provider };
}

export interface PlanModelHandle {
  adapter: OpenAiCompatibleAdapter | null;
  model: AiModelRow | null;
}

export async function getPlanModelAdapter(): Promise<PlanModelHandle> {
  const settings = await getAiSettings(db);
  const resolved = await loadConfiguredModel(settings.planModelId);
  if (!resolved) return { adapter: null, model: null };

  return {
    adapter: new OpenAiCompatibleAdapter(resolved.provider, resolved.model),
    model: resolved.model,
  };
}

export interface AnalysisModelHandle {
  adapter: OpenAiCompatibleAdapter;
  model: AiModelRow;
}

export async function getAnalysisAdapter(kind: "image" | "video"): Promise<AnalysisModelHandle> {
  const settings = await getAiSettings(db);
  const modelId = kind === "video" ? settings.videoAnalysisModelId : settings.analysisModelId;
  const resolved = await loadConfiguredModel(modelId);

  if (!resolved) {
    throw new AppError(
      409,
      "ANALYSIS_MODEL_MISSING",
      "Model analisis belum dikonfigurasi. Setel di CMS → Settings → AI.",
    );
  }

  const required: ModelCapability = kind === "video" ? "VIDEO" : "IMAGE";
  if (!resolved.model.inputCapabilities.includes(required)) {
    throw validation(
      kind === "video"
        ? "Model ini tidak mendukung input video."
        : "Model ini tidak mendukung input gambar.",
    );
  }

  return {
    adapter: new OpenAiCompatibleAdapter(resolved.provider, resolved.model),
    model: resolved.model,
  };
}

import { and, desc, eq, gte } from "drizzle-orm";

import type { DbHandle } from "../db/client.js";
import { generations } from "../db/schema.js";
import type { GenerationRow } from "../db/schema.js";

export interface RenderProgress {
  estimateMs: number | null;
  /** `null` once the render failed; nothing is left to estimate. */
  progressPercent: number | null;
}

/** Fallbacks when the workspace has no finished render to learn from yet. */
export const DEFAULT_ESTIMATE_MS: Record<"VIDEO" | "IMAGE", number> = {
  VIDEO: 90_000,
  IMAGE: 25_000,
};

const MODEL_SAMPLE = 50;
const TYPE_SAMPLE = 200;
const WINDOW_DAYS = 30;
const CACHE_TTL_MS = 30_000;
/** The bar never reaches 100 before the terminal state, and never sits at 0 while rendering. */
const RENDERING_FLOOR = 3;
const RENDERING_CEILING = 95;

const cache = new Map<string, { value: number; expiresAt: number }>();

function cached(key: string): number | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function remember(key: string, value: number): number {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

export function clearProgressCache(): void {
  cache.clear();
}

function windowStart(): Date {
  return new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

/** Mean render duration of finished rows, ignoring rows without a positive elapsed time. */
function averageDuration(rows: GenerationRow[]): number | null {
  const durations: number[] = [];
  for (const row of rows) {
    if (!row.completedAt) continue;
    const started = row.startedAt ?? row.createdAt;
    const duration = row.completedAt.getTime() - started.getTime();
    if (duration > 0) durations.push(duration);
  }
  if (durations.length === 0) return null;
  return Math.round(durations.reduce((total, value) => total + value, 0) / durations.length);
}

async function completedRows(
  db: DbHandle,
  filter: { modelId: string } | { mediaType: "VIDEO" | "IMAGE" },
  limit: number,
): Promise<GenerationRow[]> {
  const scope = "modelId" in filter ? eq(generations.modelId, filter.modelId) : eq(generations.mediaType, filter.mediaType);
  return db
    .select()
    .from(generations)
    .where(and(eq(generations.status, "COMPLETED"), gte(generations.completedAt, windowStart()), scope))
    .orderBy(desc(generations.completedAt))
    .limit(limit);
}

/**
 * Estimate order: the model's own recent average, then the media type's recent average, then the
 * fixed default. The studio renders a percentage from this, so a wrong estimate is visible but
 * harmless — it is capped below 100 until the worker reports completion.
 */
export async function estimateForModel(
  db: DbHandle,
  modelId: string | null,
  mediaType: "VIDEO" | "IMAGE",
): Promise<number> {
  if (modelId) {
    const key = `model:${modelId}:${mediaType}`;
    const hit = cached(key);
    if (hit !== null) return hit;
    const own = averageDuration(await completedRows(db, { modelId }, MODEL_SAMPLE));
    if (own !== null) return remember(key, own);
  }

  const typeKey = `type:${mediaType}`;
  const typeHit = cached(typeKey);
  if (typeHit !== null) return typeHit;
  const byType = averageDuration(await completedRows(db, { mediaType }, TYPE_SAMPLE));
  if (byType !== null) return remember(typeKey, byType);

  return DEFAULT_ESTIMATE_MS[mediaType];
}

/** One estimate per distinct model of a request; unknown models fall back to their media type. */
export async function estimatesForModels(
  db: DbHandle,
  models: { id: string | null; mediaType: "VIDEO" | "IMAGE" }[],
): Promise<Map<string, number>> {
  const estimates = new Map<string, number>();
  for (const model of models) {
    const key = model.id ?? `type:${model.mediaType}`;
    if (estimates.has(key)) continue;
    estimates.set(key, await estimateForModel(db, model.id, model.mediaType));
  }
  return estimates;
}

export function estimateOf(
  estimates: Map<string, number>,
  row: Pick<GenerationRow, "modelId" | "mediaType">,
): number {
  return estimates.get(row.modelId ?? `type:${row.mediaType}`) ?? DEFAULT_ESTIMATE_MS[row.mediaType];
}

export function progressFor(
  row: Pick<GenerationRow, "status" | "startedAt" | "createdAt" | "completedAt">,
  estimateMs: number,
): RenderProgress {
  if (row.status === "COMPLETED") return { estimateMs, progressPercent: 100 };
  if (row.status === "FAILED") return { estimateMs, progressPercent: null };
  if (row.status === "QUEUED") return { estimateMs, progressPercent: 0 };

  const startedAt = (row.startedAt ?? row.createdAt).getTime();
  const elapsed = Math.max(0, Date.now() - startedAt);
  const raw = estimateMs > 0 ? Math.round((elapsed / estimateMs) * 100) : RENDERING_FLOOR;
  return {
    estimateMs,
    progressPercent: Math.min(RENDERING_CEILING, Math.max(RENDERING_FLOOR, raw)),
  };
}

/** Progress for one row without a per-request estimate map. */
export async function progressForRow(
  db: DbHandle,
  row: GenerationRow,
): Promise<RenderProgress> {
  return progressFor(row, await estimateForModel(db, row.modelId, row.mediaType));
}

import { desc, eq } from "drizzle-orm";

import type { AiCharacterReferenceRow, AiProviderRow } from "../db/schema.js";
import { aiCharacterReferences, aiProviders } from "../db/schema.js";
import { db } from "../db/client.js";
import { AppError, notFound, validation } from "../http/errors.js";
import { logAiActivity } from "./ai-activity-log.js";
import { joinUrl, providerAuthHeaders, resolveProviderKey } from "./model-sync-service.js";
import { describeProviderFailure } from "./provider-failure.js";

const TRAIN_TIMEOUT_MS = 30_000;

export type CharacterStatus = "NOT_READY" | "QUEUED" | "IN_PROGRESS" | "COMPLETED" | "FAILED";

export interface CreateCharacterInput {
  provider: AiProviderRow;
  name: string;
  modelVersion: "v1" | "v2" | "cinema";
  imageUrls: string[];
  actorUserId: string | null;
}

interface CustomReferencePayload {
  id?: unknown;
  status?: unknown;
  thumbnail_url?: unknown;
  thumbnailUrl?: unknown;
  fail_reason?: unknown;
  failReason?: unknown;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Higgsfield answers `not_ready|queued|in_progress|completed|failed`. */
export function statusFromProvider(raw: string | null, fallback: CharacterStatus): CharacterStatus {
  const value = (raw ?? "").trim().toUpperCase().replace(/\s+/g, "_");
  if (
    value === "NOT_READY" ||
    value === "QUEUED" ||
    value === "IN_PROGRESS" ||
    value === "COMPLETED" ||
    value === "FAILED"
  ) {
    return value;
  }
  return fallback;
}

function rateLimitError(retryAfterHeader: string | null): AppError {
  const seconds = Number(retryAfterHeader);
  const wait = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 60;
  return new AppError(
    429,
    "PROVIDER_RATE_LIMIT",
    `Batas training Higgsfield tercapai. Coba lagi dalam ${wait} detik.`,
  );
}

async function send(
  provider: AiProviderRow,
  path: string,
  init: RequestInit,
): Promise<CustomReferencePayload> {
  const url = joinUrl(provider.baseUrl, path);
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...providerAuthHeaders(provider, resolveProviderKey(provider)),
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(TRAIN_TIMEOUT_MS),
    });
  } catch (error) {
    throw new AppError(502, "PROVIDER_UNREACHABLE", describeProviderFailure(error, url, TRAIN_TIMEOUT_MS));
  }

  if (response.status === 429) throw rateLimitError(response.headers.get("retry-after"));
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw new AppError(
      502,
      "PROVIDER_ERROR",
      `Provider membalas ${response.status}: ${detail || "tanpa keterangan"}`,
    );
  }

  return (await response.json().catch(() => ({}))) as CustomReferencePayload;
}

/**
 * Trains a reusable character (Soul ID) from 1–100 public image URLs. The provider id is stored so
 * the CMS can poll it and a SOUL model can pass it as `custom_reference_id`.
 */
export async function createCharacter(
  input: CreateCharacterInput,
): Promise<AiCharacterReferenceRow> {
  if (input.imageUrls.length === 0 || input.imageUrls.length > 100) {
    throw validation("Latih karakter dari 1–100 URL gambar.");
  }

  const startedAt = Date.now();
  try {
    const payload = await send(input.provider, "/v1/custom-references", {
      method: "POST",
      body: JSON.stringify({
        name: input.name.trim(),
        model_version: input.modelVersion,
        input_images: input.imageUrls.map((url) => ({ type: "image_url", image_url: url })),
      }),
    });

    const externalId = readString(payload.id);
    if (!externalId) {
      throw new AppError(502, "PROVIDER_ERROR", "Provider tidak mengembalikan id referensi.");
    }

    const [row] = await db
      .insert(aiCharacterReferences)
      .values({
        providerId: input.provider.id,
        name: input.name.trim(),
        modelVersion: input.modelVersion,
        externalId,
        status: statusFromProvider(readString(payload.status), "QUEUED"),
        inputImageUrls: input.imageUrls,
        createdByUserId: input.actorUserId,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: aiCharacterReferences.externalId,
        set: {
          name: input.name.trim(),
          modelVersion: input.modelVersion,
          status: statusFromProvider(readString(payload.status), "QUEUED"),
          inputImageUrls: input.imageUrls,
          updatedAt: new Date(),
        },
      })
      .returning();
    if (!row) throw new AppError(500, "INTERNAL", "Gagal menyimpan referensi karakter.");

    await logAiActivity({
      kind: "CHARACTER_TRAIN",
      status: "SUCCESS",
      providerId: input.provider.id,
      modelName: input.name.trim(),
      userId: input.actorUserId,
      latencyMs: Date.now() - startedAt,
      externalJobId: externalId,
      promptChars: input.imageUrls.join("\n").length,
      requestText: input.imageUrls.join("\n"),
      metadata: { modelVersion: input.modelVersion, images: input.imageUrls.length, step: "create" },
    });

    return row;
  } catch (error) {
    await logAiActivity({
      kind: "CHARACTER_TRAIN",
      status: "ERROR",
      providerId: input.provider.id,
      modelName: input.name.trim(),
      userId: input.actorUserId,
      latencyMs: Date.now() - startedAt,
      errorCode: error instanceof AppError ? error.code : "CHARACTER_CREATE_FAILED",
      errorMessage: error instanceof Error ? error.message : "Training karakter gagal.",
      metadata: { modelVersion: input.modelVersion, images: input.imageUrls.length, step: "create" },
    });
    throw error;
  }
}

/** Polls the provider once and persists the mapped state, thumbnail and failure reason. */
export async function refreshCharacter(id: string): Promise<AiCharacterReferenceRow> {
  const [row] = await db
    .select()
    .from(aiCharacterReferences)
    .where(eq(aiCharacterReferences.id, id))
    .limit(1);
  if (!row) throw notFound("Referensi karakter tidak ditemukan.");
  if (!row.externalId) throw validation("Referensi ini belum punya id provider.");

  const [provider] = await db
    .select()
    .from(aiProviders)
    .where(eq(aiProviders.id, row.providerId))
    .limit(1);
  if (!provider) throw notFound("Provider referensi ini tidak ditemukan.");

  const startedAt = Date.now();
  const payload = await send(provider, `/v1/custom-references/${row.externalId}`, { method: "GET" });
  const status = statusFromProvider(readString(payload.status), "NOT_READY");
  const failReason = readString(payload.fail_reason) ?? readString(payload.failReason);
  const thumbnailUrl = readString(payload.thumbnail_url) ?? readString(payload.thumbnailUrl);

  const [updated] = await db
    .update(aiCharacterReferences)
    .set({
      status,
      thumbnailUrl: thumbnailUrl ?? row.thumbnailUrl,
      failReason: failReason ?? (status === "FAILED" ? row.failReason : null),
      completedAt: status === "COMPLETED" ? row.completedAt ?? new Date() : row.completedAt,
      updatedAt: new Date(),
    })
    .where(eq(aiCharacterReferences.id, row.id))
    .returning();
  if (!updated) throw notFound("Referensi karakter tidak ditemukan.");

  await logAiActivity({
    kind: "CHARACTER_TRAIN",
    status: status === "FAILED" ? "ERROR" : "SUCCESS",
    providerId: provider.id,
    modelName: row.name,
    userId: row.createdByUserId,
    latencyMs: Date.now() - startedAt,
    externalJobId: row.externalId,
    responseChars: JSON.stringify(payload).length,
    errorMessage: failReason,
    metadata: { status, step: "refresh", modelVersion: row.modelVersion },
  });

  return updated;
}

export async function listCharacters(): Promise<AiCharacterReferenceRow[]> {
  return db.select().from(aiCharacterReferences).orderBy(desc(aiCharacterReferences.createdAt));
}

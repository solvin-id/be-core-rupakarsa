import type { DbHandle } from "../db/client.js";
import { db } from "../db/client.js";
import { aiActivityLogs } from "../db/schema.js";
import { logger } from "../logger.js";

export const AI_ACTIVITY_KINDS = [
  "PLAN",
  "ANALYSIS",
  "COMPRESS",
  "RENDER_SUBMIT",
  "RENDER_STATUS",
  "RENDER_COMPLETE",
  "RENDER_FAIL",
  "MODEL_SYNC",
  "PROVIDER_TEST",
  "CHARACTER_TRAIN",
] as const;
export const AI_ACTIVITY_STATUSES = ["SUCCESS", "ERROR", "PENDING"] as const;

export type AiActivityKind = (typeof AI_ACTIVITY_KINDS)[number];
export type AiActivityStatus = (typeof AI_ACTIVITY_STATUSES)[number];

/** Prompts and responses are stored clipped: this is an operations log, not a transcript store. */
const TEXT_LIMIT = 8000;
const METADATA_LIMIT = 4000;

export interface AiActivityInput {
  kind: AiActivityKind;
  status: AiActivityStatus;
  workspaceId?: string | null;
  userId?: string | null;
  folderId?: string | null;
  generationId?: string | null;
  providerId?: string | null;
  modelId?: string | null;
  modelName?: string;
  mediaType?: "VIDEO" | "IMAGE" | null;
  latencyMs?: number;
  promptChars?: number;
  responseChars?: number;
  tokensUsed?: number;
  externalJobId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  requestText?: string;
  responseText?: string;
  metadata?: Record<string, unknown>;
}

function clip(text: string | undefined, limit: number): string {
  const value = text ?? "";
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}…`;
}

/** Keeps the log row small without losing the keys an operator filters on. */
function clipMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!metadata) return {};
  const serialized = JSON.stringify(metadata);
  if (serialized.length <= METADATA_LIMIT) return metadata;
  return { truncated: true, preview: `${serialized.slice(0, METADATA_LIMIT)}…` };
}

/**
 * One append-only row per outbound AI request or terminal render event. Logging is best-effort: a
 * failed insert is reported to the logger and never fails the operation it describes.
 */
export async function logAiActivity(
  input: AiActivityInput,
  handle: DbHandle = db,
): Promise<void> {
  try {
    await handle.insert(aiActivityLogs).values({
      workspaceId: input.workspaceId ?? null,
      userId: input.userId ?? null,
      folderId: input.folderId ?? null,
      generationId: input.generationId ?? null,
      kind: input.kind,
      status: input.status,
      providerId: input.providerId ?? null,
      modelId: input.modelId ?? null,
      modelName: input.modelName ?? "",
      mediaType: input.mediaType ?? null,
      latencyMs: Math.max(0, Math.round(input.latencyMs ?? 0)),
      promptChars: Math.max(0, input.promptChars ?? 0),
      responseChars: Math.max(0, input.responseChars ?? 0),
      tokensUsed: Math.max(0, input.tokensUsed ?? 0),
      externalJobId: input.externalJobId ?? null,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ? clip(input.errorMessage, 2000) : null,
      requestText: clip(input.requestText, TEXT_LIMIT),
      responseText: clip(input.responseText, TEXT_LIMIT),
      metadata: clipMetadata(input.metadata),
    });
  } catch (error) {
    logger.warn({ err: error, kind: input.kind }, "ai activity log write failed");
  }
}

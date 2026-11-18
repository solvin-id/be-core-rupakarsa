import type { AiModelRow, GenerationParams } from "../db/schema.js";
import { AppError, validation } from "../http/errors.js";
import { getPlanModelAdapter } from "../providers/registry.js";
import type { ChatContentPart } from "../adapters/types.js";
import { logAiActivity } from "./ai-activity-log.js";
import { NEGATIVE_PROMPT, buildPlanBlueprint } from "./plan-blueprint.js";

export interface PlanAttachment {
  url: string;
  kind: "IMAGE" | "VIDEO";
}

export interface PlanModelInput {
  workspaceId: string;
  folderId: string;
  renderModel: AiModelRow;
  rawPrompt: string;
  attachmentTexts: string[];
  attachments: PlanAttachment[];
  contextText: string;
  selectedParams: GenerationParams;
  hasReference: boolean;
  /** Character ceiling the render step will enforce, so the plan is written to fit. */
  promptLimit: number;
  /** Plan mode is reviewed by the user; direct mode is consumed by the render immediately. */
  mode: "plan" | "direct";
  /** Operator-facing user id, recorded on the activity log. */
  userId?: string | null;
}

export interface PlanModelOutput {
  prompt: string;
  direction: string;
  negativePrompt: string;
  usedModelId: string;
}

export const PLAN_SYSTEM_PROMPT =
  "You are a prompt engineer for AI video and image generation. Merge the brief, the attachment analyses, the attached media, and the project pre-context into one production-ready prompt. Preserve facts from the pre-context; never invent brand names. Keep the prompt at or below the character limit supplied in PARAMS. Reply with strict JSON {prompt, direction, negativePrompt}.";

/**
 * Server-side capability gate: an attachment type the plan model cannot read is rejected with the
 * exact message the studio surfaces, never silently dropped.
 */
export function assertAttachmentsSupported(
  model: AiModelRow,
  attachments: PlanAttachment[],
): void {
  for (const attachment of attachments) {
    if (!model.inputCapabilities.includes(attachment.kind)) {
      throw validation(
        attachment.kind === "VIDEO"
          ? "Model plan tidak mendukung lampiran video. Pilih model plan lain atau hapus lampiran."
          : "Model plan tidak mendukung lampiran gambar. Pilih model plan lain atau hapus lampiran.",
      );
    }
  }
}

export function stripFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced?.[1]?.trim() ?? trimmed;
}

function parsePlan(raw: string): { prompt: string; direction: string; negativePrompt: string } {
  try {
    const parsed: unknown = JSON.parse(stripFences(raw));
    if (parsed && typeof parsed === "object") {
      const record = parsed as { prompt?: unknown; direction?: unknown; negativePrompt?: unknown };
      const prompt = typeof record.prompt === "string" ? record.prompt.trim() : "";
      if (prompt.length > 0) {
        return {
          prompt,
          direction: typeof record.direction === "string" ? record.direction : "",
          negativePrompt:
            typeof record.negativePrompt === "string" && record.negativePrompt.trim().length > 0
              ? record.negativePrompt
              : NEGATIVE_PROMPT,
        };
      }
    }
  } catch {
    // Fall through to the raw-text shape below.
  }
  const text = stripFences(raw).trim();
  if (text.length === 0) {
    throw new AppError(502, "PROVIDER_ERROR", "Model plan mengembalikan jawaban kosong.");
  }
  return { prompt: text, direction: "", negativePrompt: NEGATIVE_PROMPT };
}

function buildUserText(input: PlanModelInput): string {
  const params = [
    input.renderModel.mediaType === "VIDEO" && input.selectedParams.durationSec
      ? `duration: ${input.selectedParams.durationSec}s`
      : null,
    `resolution: ${input.selectedParams.resolution}`,
    `aspect: ${input.selectedParams.aspectRatio}`,
    `model: ${input.renderModel.displayName}`,
    `has reference: ${input.hasReference ? "yes" : "no"}`,
    `max characters: ${input.promptLimit}`,
  ]
    .filter(Boolean)
    .join(", ");

  return [
    input.contextText.trim().length > 0 ? input.contextText.trim() : null,
    `[BRIEF]\n${input.rawPrompt.trim()}`,
    input.attachmentTexts.length > 0
      ? `[ATTACHMENT NOTES]\n${input.attachmentTexts.map((text, index) => `#${index + 1} ${text}`).join("\n")}`
      : null,
    `[PARAMS]\n${params}`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n\n");
}

/**
 * Deterministic composer used when no plan model is configured (or its call fails in direct mode).
 * It applies the same production blueprint a planned render gets, so a direct render is never just
 * the raw brief concatenated with notes.
 */
export function buildDirectPrompt(input: {
  rawPrompt: string;
  model: AiModelRow;
  durationSec?: number;
  resolution: string;
  aspectRatio: string;
  hasReference: boolean;
  attachmentTexts: string[];
  continuityText: string;
}): string {
  const blueprint = buildPlanBlueprint({
    rawPrompt: input.rawPrompt,
    model: input.model,
    durationSec: input.durationSec,
    resolution: input.resolution,
    aspectRatio: input.aspectRatio,
    hasReference: input.hasReference,
  });

  const continuity = input.continuityText.trim();
  return [
    continuity.length > 0 ? continuity : null,
    blueprint.prompt,
    input.attachmentTexts.length > 0
      ? `[ATTACHMENT NOTES]\n${input.attachmentTexts.map((text, index) => `#${index + 1} ${text}`).join("\n")}`
      : null,
    continuity.includes("[PREVIOUS SCENE]")
      ? "[STYLE LOCK] Same film as previous scene: palette, grade, lens and wardrobe unchanged."
      : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n\n");
}

/**
 * The single plan-model entry point: plan mode reviews the result in the UI, direct mode lets the
 * server use it immediately. Without a configured plan model the deterministic blueprint applies.
 */
export async function runPlanModel(input: PlanModelInput): Promise<PlanModelOutput> {
  const { adapter, model } = await getPlanModelAdapter();
  const startedAt = Date.now();

  const base = {
    workspaceId: input.workspaceId,
    userId: input.userId ?? null,
    folderId: input.folderId,
    modelId: model?.id ?? null,
    modelName: model?.displayName ?? input.renderModel.displayName,
    // `runPlanModel` is only reached for render models; TEXT rows never create a generation.
    mediaType: input.renderModel.mediaType === "TEXT" ? null : input.renderModel.mediaType,
    promptChars: input.rawPrompt.trim().length,
    metadata: { mode: input.mode, promptLimit: input.promptLimit },
  } as const;

  if (!adapter || !model) {
    const blueprint = buildPlanBlueprint({
      rawPrompt: input.rawPrompt,
      model: input.renderModel,
      durationSec: input.selectedParams.durationSec,
      resolution: input.selectedParams.resolution,
      aspectRatio: input.selectedParams.aspectRatio,
      hasReference: input.hasReference,
    });
    await logAiActivity({
      ...base,
      kind: "PLAN",
      status: "SUCCESS",
      latencyMs: Date.now() - startedAt,
      responseChars: blueprint.prompt.length,
      requestText: input.rawPrompt,
      responseText: blueprint.prompt,
      metadata: { ...base.metadata, fallback: true },
    });
    return { ...blueprint, usedModelId: "" };
  }

  assertAttachmentsSupported(model, input.attachments);

  const text = buildUserText(input);
  const parts: ChatContentPart[] = [{ type: "text", text }];
  for (const attachment of input.attachments) {
    parts.push(
      attachment.kind === "VIDEO"
        ? { type: "video_url", video_url: { url: attachment.url } }
        : { type: "image_url", image_url: { url: attachment.url } },
    );
  }

  try {
    const result = await adapter.chat({
      model: model.providerModelId || model.code,
      messages: [
        { role: "system", content: PLAN_SYSTEM_PROMPT },
        { role: "user", content: parts },
      ],
      json: true,
    });

    const parsed = parsePlan(result.text);
    await logAiActivity({
      ...base,
      kind: "PLAN",
      status: "SUCCESS",
      latencyMs: Date.now() - startedAt,
      tokensUsed: result.usage.totalTokens,
      responseChars: result.text.length,
      requestText: text,
      responseText: result.text,
      metadata: { ...base.metadata, fallback: false },
    });
    return { ...parsed, usedModelId: model.id };
  } catch (error) {
    const appError = error instanceof AppError ? error : null;
    await logAiActivity({
      ...base,
      kind: "PLAN",
      status: "ERROR",
      latencyMs: Date.now() - startedAt,
      requestText: text,
      errorCode: appError?.code ?? "PLAN_FAILED",
      errorMessage: error instanceof Error ? error.message : "Model plan gagal.",
      metadata: { ...base.metadata, fallback: false },
    });
    throw error;
  }
}

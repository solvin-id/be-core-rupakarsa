import type { AiModelRow, GenerationParams } from "../db/schema.js";
import { AppError, validation } from "../http/errors.js";
import { getPlanModelAdapter } from "../providers/registry.js";
import type { ChatContentPart } from "../adapters/types.js";
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
}

export interface PlanModelOutput {
  prompt: string;
  direction: string;
  negativePrompt: string;
  usedModelId: string;
}

export const PLAN_SYSTEM_PROMPT =
  "You are a prompt engineer for AI video and image generation. Merge the brief, the attachment analyses, the attached media, and the project pre-context into one production-ready prompt. Preserve facts from the pre-context; never invent brand names. Reply with strict JSON {prompt, direction, negativePrompt}.";

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

function buildUserText(input: PlanModelInput, attachmentTexts: string[]): string {
  const params = [
    input.renderModel.mediaType === "VIDEO" && input.selectedParams.durationSec
      ? `duration: ${input.selectedParams.durationSec}s`
      : null,
    `resolution: ${input.selectedParams.resolution}`,
    `aspect: ${input.selectedParams.aspectRatio}`,
    `model: ${input.renderModel.displayName}`,
    `has reference: ${input.hasReference ? "yes" : "no"}`,
  ]
    .filter(Boolean)
    .join(", ");

  return [
    `[BRIEF]\n${input.rawPrompt.trim()}`,
    input.contextText.trim().length > 0 ? `[PRE-CONTEXT]\n${input.contextText.trim()}` : null,
    attachmentTexts.length > 0
      ? `[ATTACHMENT NOTES]\n${attachmentTexts.map((text, index) => `#${index + 1} ${text}`).join("\n")}`
      : null,
    `[PARAMS]\n${params}`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n\n");
}

/**
 * Direct mode never calls a plan model: the brief, the attachment analyses and the project
 * pre-context are assembled verbatim, in the same labels the plan prompt uses, and rendered.
 */
export function buildDirectPrompt(input: {
  rawPrompt: string;
  attachmentTexts: string[];
  contextText: string;
}): string {
  return [
    `[BRIEF]\n${input.rawPrompt.trim()}`,
    input.attachmentTexts.length > 0
      ? `[ATTACHMENT NOTES]\n${input.attachmentTexts.map((text, index) => `#${index + 1} ${text}`).join("\n")}`
      : null,
    input.contextText.trim().length > 0 ? `[PRE-CONTEXT]\n${input.contextText.trim()}` : null,
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

  if (!adapter || !model) {
    const blueprint = buildPlanBlueprint({
      rawPrompt: input.rawPrompt,
      model: input.renderModel,
      durationSec: input.selectedParams.durationSec,
      resolution: input.selectedParams.resolution,
      aspectRatio: input.selectedParams.aspectRatio,
      hasReference: input.hasReference,
    });
    return { ...blueprint, usedModelId: "" };
  }

  assertAttachmentsSupported(model, input.attachments);

  const text = buildUserText(input, input.attachmentTexts);
  const parts: ChatContentPart[] = [{ type: "text", text }];
  for (const attachment of input.attachments) {
    parts.push(
      attachment.kind === "VIDEO"
        ? { type: "video_url", video_url: { url: attachment.url } }
        : { type: "image_url", image_url: { url: attachment.url } },
    );
  }

  const result = await adapter.chat({
    model: model.providerModelId || model.code,
    messages: [
      { role: "system", content: PLAN_SYSTEM_PROMPT },
      { role: "user", content: parts },
    ],
    json: true,
  });

  const parsed = parsePlan(result.text);
  return { ...parsed, usedModelId: model.id };
}

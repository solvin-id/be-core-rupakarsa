import { getPlanModelAdapter } from "../providers/registry.js";
import { logAiActivity } from "./ai-activity-log.js";
import { stripFences } from "./plan-service.js";

export const PROMPT_COMPRESS_SYSTEM =
  "Compress the given production prompt to at most the requested number of characters. Keep every subject, action, setting, camera, lighting and style constraint; drop repetition and filler. Reply with the compressed prompt only.";

/** Guards the provider from a pathological prompt: the model never needs more than a few copies. */
const MAX_INPUT_RATIO = 4;

/** Hard fallback: cut at the last word boundary and drop trailing punctuation. */
export function truncateToLimit(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = text.slice(0, Math.max(0, limit));
  const boundary = head.lastIndexOf(" ");
  const base = (boundary > 0 ? head.slice(0, boundary) : head).trimEnd();
  return base.replace(/[,;:.\-\s]+$/, "").trimEnd();
}

/**
 * Fits `prompt` into `limit` characters. The plan model does the rewrite when it is configured;
 * without it (or when the provider fails) the prompt is truncated so a render still runs.
 */
export async function compressPrompt(input: {
  prompt: string;
  limit: number;
  workspaceId?: string | null;
}): Promise<{ prompt: string; compressed: boolean }> {
  const prompt = input.prompt.trim();
  if (prompt.length <= input.limit) return { prompt, compressed: false };

  const startedAt = Date.now();
  const log = (result: { prompt: string; compressed: boolean }, fallback: boolean, error?: unknown) =>
    logAiActivity({
      kind: "COMPRESS",
      status: error ? "ERROR" : "SUCCESS",
      workspaceId: input.workspaceId ?? null,
      latencyMs: Date.now() - startedAt,
      promptChars: prompt.length,
      responseChars: result.prompt.length,
      requestText: prompt,
      responseText: result.prompt,
      errorMessage: error instanceof Error ? error.message : null,
      metadata: {
        limit: input.limit,
        before: prompt.length,
        after: result.prompt.length,
        fallback,
      },
    });

  const { adapter, model } = await getPlanModelAdapter();
  if (!adapter || !model) {
    const truncated = { prompt: truncateToLimit(prompt, input.limit), compressed: true };
    await log(truncated, true);
    return truncated;
  }

  const source = prompt.slice(0, input.limit * MAX_INPUT_RATIO);
  try {
    const result = await adapter.chat({
      model: model.providerModelId || model.code,
      messages: [
        { role: "system", content: PROMPT_COMPRESS_SYSTEM },
        { role: "user", content: `Limit: ${input.limit} characters.\n\n${source}` },
      ],
      json: false,
    });
    const candidate = stripFences(result.text).trim();
    if (candidate.length === 0 || candidate.length > input.limit) {
      const clamped = {
        prompt: truncateToLimit(candidate.length > 0 ? candidate : prompt, input.limit),
        compressed: true,
      };
      await log(clamped, true);
      return clamped;
    }
    const fitted = { prompt: candidate, compressed: true };
    await log(fitted, false);
    return fitted;
  } catch (error) {
    const truncated = { prompt: truncateToLimit(prompt, input.limit), compressed: true };
    await log(truncated, true, error);
    return truncated;
  }
}

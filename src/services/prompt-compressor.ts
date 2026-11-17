import { getPlanModelAdapter } from "../providers/registry.js";
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
}): Promise<{ prompt: string; compressed: boolean }> {
  const prompt = input.prompt.trim();
  if (prompt.length <= input.limit) return { prompt, compressed: false };

  const { adapter, model } = await getPlanModelAdapter();
  if (!adapter || !model) return { prompt: truncateToLimit(prompt, input.limit), compressed: true };

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
      return { prompt: truncateToLimit(candidate.length > 0 ? candidate : prompt, input.limit), compressed: true };
    }
    return { prompt: candidate, compressed: true };
  } catch {
    return { prompt: truncateToLimit(prompt, input.limit), compressed: true };
  }
}

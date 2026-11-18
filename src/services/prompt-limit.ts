import type { AiModelRow } from "../db/schema.js";
import type { LimitsSettings } from "./settings.js";

/**
 * Effective final-prompt ceiling. `max_prompt_chars = 0` used to slip through the CMS and compressed
 * every prompt to nothing, so zero (or anything non-positive) now means "unset" and falls back to
 * the workspace default.
 */
export function promptLimitFor(
  model: Pick<AiModelRow, "maxPromptChars">,
  limits: Pick<LimitsSettings, "finalPromptMaxChars">,
): number {
  const own = model.maxPromptChars ?? 0;
  return own > 0 ? own : limits.finalPromptMaxChars;
}

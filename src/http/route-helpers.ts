import type { Context } from "hono";
import type { ZodError } from "zod";

import { errorBody } from "./error-handler.js";
import type { ErrorBody } from "./types.js";

export type ValidationTarget = { success: true } | { success: false; error: ZodError };

/**
 * Shared `defaultHook` for OpenAPIHono instances: maps request-validation failures onto the
 * API's `{ error: { code, message } }` envelope instead of Zod's default shape.
 */
export function defaultHook(
  result: ValidationTarget,
  c: Context,
): Response | undefined {
  if (result.success) return undefined;
  const message = result.error.issues[0]?.message ?? "Data yang dikirim tidak valid.";
  return c.json<ErrorBody>(errorBody("VALIDATION_ERROR", message), 400);
}

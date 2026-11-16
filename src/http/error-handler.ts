import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";

import { logger } from "../logger.js";
import { AppError } from "./errors.js";
import type { ErrorBody } from "./types.js";

export function errorBody(code: string, message: string): ErrorBody {
  return { error: { code, message } };
}

export function errorResponse(error: Error, requestId?: string): { status: number; body: ErrorBody } {
  if (error instanceof AppError) {
    return { status: error.status, body: errorBody(error.code, error.message) };
  }
  if (error instanceof ZodError) {
    const first = error.issues[0];
    return {
      status: 400,
      body: errorBody("VALIDATION_ERROR", first?.message ?? "Data yang dikirim tidak valid."),
    };
  }
  if (error instanceof HTTPException) {
    return {
      status: error.status,
      body: errorBody(
        error.status === 404 ? "NOT_FOUND" : "HTTP_ERROR",
        error.message || "Permintaan tidak dapat diproses.",
      ),
    };
  }
  logger.error({ err: error, requestId }, "unhandled error");
  return {
    status: 500,
    body: errorBody("INTERNAL", "Terjadi kesalahan pada server."),
  };
}

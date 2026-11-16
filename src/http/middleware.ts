import type { Context, MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";

import { env } from "../env.js";
import { AppError, forbidden } from "./errors.js";
import { logger } from "../logger.js";
import type { AppBindings } from "./types.js";

export function requestId(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const id = crypto.randomUUID();
    c.set("requestId", id);
    c.header("X-Request-Id", id);
    await next();
  };
}

export function requestLogger(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const startedAt = Date.now();
    await next();
    logger.info(
      {
        requestId: c.get("requestId"),
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs: Date.now() - startedAt,
      },
      "request",
    );
  };
}

export function originGuard(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") {
      await next();
      return;
    }
    const origin = c.req.header("origin");
    if (!origin) {
      await next();
      return;
    }
    if (!env.FRONTEND_ORIGINS.includes(origin)) {
      throw forbidden("Origin tidak diizinkan.");
    }
    await next();
  };
}

export function corsMiddleware(): MiddlewareHandler<AppBindings> {
  return cors({
    origin: (origin) => (env.FRONTEND_ORIGINS.includes(origin) ? origin : ""),
    credentials: true,
    allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "X-Request-Id"],
    exposeHeaders: ["X-Request-Id"],
    maxAge: 600,
  });
}

export const jsonBodyLimit = bodyLimit({
  maxSize: 1024 * 1024,
  onError: () => {
    throw new AppError(413, "PAYLOAD_TOO_LARGE", "Ukuran permintaan terlalu besar.");
  },
});

export const uploadBodyLimit = bodyLimit({
  maxSize: 12 * 1024 * 1024,
  onError: () => {
    throw new AppError(413, "PAYLOAD_TOO_LARGE", "Ukuran gambar maksimal 10 MB.");
  },
});

export { secureHeaders };

export function clientIp(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return c.req.header("x-real-ip") ?? "unknown";
}

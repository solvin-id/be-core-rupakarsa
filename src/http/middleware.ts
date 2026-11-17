import type { Context, MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";

import { CSRF_COOKIE, SESSION_COOKIE, cookieValues, writeCsrfCookie } from "../auth/session.js";
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
    allowHeaders: ["Content-Type", "X-Request-Id", "X-Csrf-Token"],
    exposeHeaders: ["X-Request-Id"],
    maxAge: 600,
  });
}

/**
 * Double-submit cookie: every cookie-authenticated mutation must echo a CSRF cookie value in
 * `x-csrf-token`. Requests without a session cookie (login, password reset, webhooks) pass through
 * untouched. A browser may send more than one value for the same name (a host-only leftover next to
 * the domain cookie), and the page can only read the ones its own origin owns, so any match counts.
 */
export function csrfMiddleware(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const method = c.req.method.toUpperCase();
    const hasSession = cookieValues(c, SESSION_COOKIE).length > 0;
    const csrfValues = cookieValues(c, CSRF_COOKIE);

    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
      await next();
      // A session minted before this cookie existed can never pass the check on its own: the page
      // cannot read a token that was never issued. Issue one here so the next action just works.
      if (hasSession && csrfValues.length === 0) {
        writeCsrfCookie(c);
        logger.info(
          { requestId: c.get("requestId"), event: "csrf.healed", path: c.req.path },
          "csrf cookie issued",
        );
      }
      return;
    }

    if (!hasSession) {
      await next();
      return;
    }

    const headerToken = c.req.header("x-csrf-token") ?? "";
    if (headerToken.length === 0 || !csrfValues.includes(headerToken)) {
      // Counts only: whether the browser sent 0, 1 or several csrf cookies decides the fix.
      logger.warn(
        {
          requestId: c.get("requestId"),
          event: "csrf.rejected",
          method,
          path: c.req.path,
          csrfCookies: csrfValues.length,
          headerPresent: headerToken.length > 0,
        },
        "csrf rejected",
      );
      // No cookie at all means the browser has nothing to echo: hand it one so an immediate retry
      // succeeds. A present-but-mismatched cookie is a real attack signal and stays untouched.
      if (csrfValues.length === 0) writeCsrfCookie(c);
      throw new AppError(403, "CSRF_INVALID", "Token CSRF tidak valid. Muat ulang halaman.");
    }
    await next();
  };
}

export const jsonBodyLimit = bodyLimit({
  maxSize: 1024 * 1024,
  onError: () => {
    throw new AppError(413, "PAYLOAD_TOO_LARGE", "Ukuran permintaan terlalu besar.");
  },
});

export const uploadBodyLimit = bodyLimit({
  maxSize: 104 * 1024 * 1024,
  onError: () => {
    throw new AppError(413, "PAYLOAD_TOO_LARGE", "Berkas maksimal 100 MB.");
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

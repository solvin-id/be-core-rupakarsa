import { Redis } from "ioredis";
import type { MiddlewareHandler } from "hono";

import { db } from "../db/client.js";
import { env } from "../env.js";
import { clientIp } from "./middleware.js";
import { AppError } from "./errors.js";
import { getSecuritySettings } from "../services/settings.js";
import type { AppBindings } from "./types.js";

let client: Redis | null = null;
let failClosedCache: { value: boolean; expiresAt: number } | null = null;

function redis(): Redis {
  if (!client) {
    client = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true });
    client.on("error", () => {
      // Rate limiting degrades gracefully; request handling continues unless fail-closed is on.
    });
  }
  return client;
}

export async function closeRateLimitRedis(): Promise<void> {
  if (!client) return;
  await client.quit();
  client = null;
}

async function failClosed(): Promise<boolean> {
  if (failClosedCache && failClosedCache.expiresAt > Date.now()) return failClosedCache.value;
  try {
    const settings = await getSecuritySettings(db);
    failClosedCache = { value: settings.rateLimitFailClosed, expiresAt: Date.now() + 60_000 };
    return settings.rateLimitFailClosed;
  } catch {
    return false;
  }
}

export function resetRateLimitCache(): void {
  failClosedCache = null;
}

interface LimitOptions {
  key: string;
  limit: number;
  windowSeconds: number;
  message: string;
}

export async function hitLimit(options: LimitOptions, identity: string): Promise<void> {
  if (env.RATE_LIMIT_DISABLED) return;
  const redisClient = redis();
  const bucket = `ratelimit:${options.key}:${identity}`;
  try {
    if (redisClient.status === "wait") await redisClient.connect();
    const count = await redisClient.incr(bucket);
    if (count === 1) await redisClient.expire(bucket, options.windowSeconds);
    if (count > options.limit) {
      throw new AppError(429, "RATE_LIMITED", options.message);
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    // Redis unavailable: fail open so the API stays usable, unless the operator opted into
    // failing closed for this surface.
    if (await failClosed()) {
      throw new AppError(503, "RATE_LIMIT_UNAVAILABLE", "Layanan pembatas permintaan tidak tersedia.");
    }
  }
}

export function loginLimiter(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    await hitLimit(
      {
        key: "login",
        limit: 10,
        windowSeconds: 5 * 60,
        message: "Terlalu banyak percobaan masuk. Coba lagi beberapa menit.",
      },
      clientIp(c),
    );
    await next();
  };
}

export function mutationLimiter(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const auth = c.get("auth");
    await hitLimit(
      {
        key: "mutation",
        limit: 120,
        windowSeconds: 60,
        message: "Terlalu banyak permintaan. Coba lagi sebentar.",
      },
      auth?.user.id ?? clientIp(c),
    );
    await next();
  };
}

/** Guard for the three expensive AI endpoints: plan, create generation, and media analysis. */
export function expensiveLimiter(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const auth = c.get("auth");
    await hitLimit(
      {
        key: "expensive",
        limit: 20,
        windowSeconds: 5 * 60,
        message: "Terlalu banyak permintaan AI. Tunggu beberapa menit.",
      },
      auth?.user.id ?? clientIp(c),
    );
    await next();
  };
}

export function passwordResetLimiter(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    await hitLimit(
      {
        key: "password-reset",
        limit: 5,
        windowSeconds: 15 * 60,
        message: "Terlalu banyak permintaan reset password. Coba lagi nanti.",
      },
      clientIp(c),
    );
    await next();
  };
}

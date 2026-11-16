import { Redis } from "ioredis";
import type { MiddlewareHandler } from "hono";

import { env } from "../env.js";
import { clientIp } from "./middleware.js";
import { AppError } from "./errors.js";
import type { AppBindings } from "./types.js";

let client: Redis | null = null;

function redis(): Redis {
  if (!client) {
    client = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true });
    client.on("error", () => {
      // Rate limiting degrades gracefully; request handling continues.
    });
  }
  return client;
}

export async function closeRateLimitRedis(): Promise<void> {
  if (!client) return;
  await client.quit();
  client = null;
}

interface LimitOptions {
  key: string;
  limit: number;
  windowSeconds: number;
  message: string;
}

async function hit(options: LimitOptions, identity: string): Promise<void> {
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
    // Redis unavailable: fail open so the API stays usable.
  }
}

export function loginLimiter(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    await hit(
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
    await hit(
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

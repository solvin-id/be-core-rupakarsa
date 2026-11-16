import type { Redis } from "ioredis";

import { createRedisConnection } from "../queue/generation-queue.js";

const PREFIX = "rupakarsa:challenge:";

let client: Redis | null = null;

function redis(): Redis {
  if (!client) client = createRedisConnection();
  return client;
}

export async function putChallenge(token: string, payload: unknown, ttlSeconds: number): Promise<void> {
  await redis().set(`${PREFIX}${token}`, JSON.stringify(payload), "EX", ttlSeconds);
}

export async function readChallenge<T>(token: string): Promise<T | null> {
  const raw = await redis().get(`${PREFIX}${token}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function deleteChallenge(token: string): Promise<void> {
  await redis().del(`${PREFIX}${token}`);
}

export async function closeChallengeStore(): Promise<void> {
  if (!client) return;
  await client.quit().catch(() => undefined);
  client = null;
}

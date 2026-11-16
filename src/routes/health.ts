import { sql } from "drizzle-orm";
import { OpenAPIHono, createRoute } from "@hono/zod-openapi";

import { db } from "../db/client.js";
import { env } from "../env.js";
import { defaultHook } from "../http/route-helpers.js";
import { HealthSchema } from "../http/schemas.js";
import type { AppBindings } from "../http/types.js";
import { pingRedis } from "../queue/index.js";
import { createRedisConnection } from "../queue/generation-queue.js";

export const healthRoutes = new OpenAPIHono<AppBindings>({ defaultHook });

const WORKER_HEARTBEAT_KEY = "rupakarsa:worker:heartbeat";

async function workerAlive(): Promise<boolean> {
  const connection = createRedisConnection();
  try {
    const raw = await connection.get(WORKER_HEARTBEAT_KEY);
    if (!raw) return false;
    const beatAt = Number(raw);
    if (!Number.isFinite(beatAt)) return false;
    return Date.now() - beatAt <= env.WORKER_HEARTBEAT_SECONDS * 3000;
  } catch {
    return false;
  } finally {
    await connection.quit().catch(() => undefined);
  }
}

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  tags: ["Infra"],
  responses: {
    200: {
      description: "Service health",
      content: { "application/json": { schema: HealthSchema } },
    },
    503: {
      description: "One dependency is unhealthy",
      content: { "application/json": { schema: HealthSchema } },
    },
  },
});

healthRoutes.openapi(healthRoute, async (c) => {
  let dbOk = true;
  try {
    await db.execute(sql`select 1`);
  } catch {
    dbOk = false;
  }

  const [redisOk, worker] = await Promise.all([pingRedis(), workerAlive()]);
  const healthy = dbOk && redisOk && worker;

  return c.json(
    {
      status: healthy ? ("ok" as const) : ("degraded" as const),
      db: dbOk,
      redis: redisOk,
      worker,
    },
    healthy ? 200 : 503,
  );
});

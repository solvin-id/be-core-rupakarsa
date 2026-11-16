import { serve } from "@hono/node-server";

import { createApp } from "./app.js";
import { closeDb } from "./db/client.js";
import { env } from "./env.js";
import { logger } from "./logger.js";
import { closeRateLimitRedis } from "./http/rate-limit.js";
import { closeQueue } from "./queue/index.js";

const app = createApp();

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info({ port: info.port }, "rupakarsa api listening");
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down");

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  await closeRateLimitRedis();
  await closeQueue();
  await closeDb();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

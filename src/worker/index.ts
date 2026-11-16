import { Worker } from "bullmq";

import { closeDb } from "../db/client.js";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { GENERATION_QUEUE, createRedisConnection, closeQueue } from "../queue/generation-queue.js";
import type { RenderJob } from "../queue/generation-queue.js";
import { renderGeneration } from "./render-generation.js";

const connection = createRedisConnection();

const worker = new Worker<RenderJob>(
  GENERATION_QUEUE,
  async (job) => {
    logger.info({ generationId: job.data.generationId }, "rendering generation");
    await renderGeneration(job.data);
  },
  { connection, concurrency: 2 },
);

worker.on("failed", (job, error) => {
  logger.error({ err: error, jobId: job?.id }, "render job failed");
});

logger.info({ driver: env.GENERATION_DRIVER, queue: GENERATION_QUEUE }, "worker started");

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "worker shutting down");
  await worker.close();
  await connection.quit();
  await closeQueue();
  await closeDb();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

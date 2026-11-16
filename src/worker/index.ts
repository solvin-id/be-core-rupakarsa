import { Worker } from "bullmq";

import { closeDb } from "../db/client.js";
import { env } from "../env.js";
import { logger } from "../logger.js";
import {
  ACCOUNT_PURGE_JOB,
  GENERATION_QUEUE,
  MEDIA_SWEEP_JOB,
  closeQueue,
  createRedisConnection,
  ensureMediaSweepJob,
} from "../queue/generation-queue.js";
import type { RenderJob } from "../queue/generation-queue.js";
import { purgeDeletedAccounts } from "../routes/creator/account.js";
import { startEmailWorker } from "./email-worker.js";
import { sweepMedia } from "./media-sweep.js";
import { renderGeneration } from "./render-generation.js";

export const WORKER_HEARTBEAT_KEY = "rupakarsa:worker:heartbeat";

const connection = createRedisConnection();
const heartbeat = createRedisConnection();

async function beat(): Promise<void> {
  try {
    await heartbeat.set(WORKER_HEARTBEAT_KEY, String(Date.now()), "EX", env.WORKER_HEARTBEAT_SECONDS * 3);
  } catch (error) {
    logger.warn({ err: error }, "worker heartbeat failed");
  }
}

const worker = new Worker<RenderJob | Record<string, never>>(
  GENERATION_QUEUE,
  async (job) => {
    if (job.name === MEDIA_SWEEP_JOB) {
      await sweepMedia();
      return;
    }
    if (job.name === ACCOUNT_PURGE_JOB) {
      const purged = await purgeDeletedAccounts();
      logger.info({ purged }, "account purge finished");
      return;
    }
    const data = job.data as RenderJob;
    logger.info({ generationId: data.generationId }, "rendering generation");
    await renderGeneration(data);
  },
  { connection, concurrency: env.RENDER_CONCURRENCY },
);

worker.on("failed", (job, error) => {
  logger.error({ err: error, jobId: job?.id }, "render job failed");
});

void beat();
const heartbeatTimer = setInterval(() => void beat(), env.WORKER_HEARTBEAT_SECONDS * 1000);
heartbeatTimer.unref();

await ensureMediaSweepJob();
const emailWorker = startEmailWorker();
logger.info(
  { driver: env.GENERATION_DRIVER, queue: GENERATION_QUEUE, concurrency: env.RENDER_CONCURRENCY },
  "worker started",
);

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "worker shutting down");
  clearInterval(heartbeatTimer);
  await worker.close();
  await emailWorker.close();
  await connection.quit();
  await heartbeat.quit().catch(() => undefined);
  await closeQueue();
  await closeDb();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

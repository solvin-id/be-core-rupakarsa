import { Queue, QueueEvents } from "bullmq";
import { Redis } from "ioredis";

import { env } from "../env.js";

export const GENERATION_QUEUE = "generation";
export const MEDIA_SWEEP_JOB = "media-sweep";
export const ACCOUNT_PURGE_JOB = "account-purge";
const MEDIA_SWEEP_INTERVAL_MS = 3_600_000;
const ACCOUNT_PURGE_INTERVAL_MS = 86_400_000;

export interface RenderJobData {
  generationId: string;
  simulateFailure: boolean;
}

export type RenderJob = RenderJobData;
export type SweepJob = Record<string, never>;

let queue: Queue<RenderJobData | SweepJob> | null = null;
let queueEvents: QueueEvents | null = null;
let queueConnection: Redis | null = null;
let eventsConnection: Redis | null = null;

export function createRedisConnection(): Redis {
  return new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
}

function getQueue(): Queue<RenderJobData | SweepJob> {
  if (!queue) {
    queueConnection = createRedisConnection();
    queue = new Queue<RenderJobData | SweepJob>(GENERATION_QUEUE, { connection: queueConnection });
  }
  return queue;
}

function getQueueEvents(): QueueEvents {
  if (!queueEvents) {
    eventsConnection = createRedisConnection();
    queueEvents = new QueueEvents(GENERATION_QUEUE, { connection: eventsConnection });
  }
  return queueEvents;
}

export async function enqueueRender(
  generationId: string,
  options: { simulateFailure: boolean },
): Promise<void> {
  getQueueEvents();
  await getQueue().add(
    "render",
    { generationId, simulateFailure: options.simulateFailure },
    {
      removeOnComplete: 200,
      removeOnFail: { count: 1000 },
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
    },
  );
}

/** Idempotent repeatable job: BullMQ dedupes by jobId, so restarts never multiply sweepers. */
export async function ensureMediaSweepJob(): Promise<void> {
  await getQueue().add(
    MEDIA_SWEEP_JOB,
    {},
    {
      jobId: MEDIA_SWEEP_JOB,
      repeat: { every: MEDIA_SWEEP_INTERVAL_MS },
      removeOnComplete: 20,
      removeOnFail: 20,
    },
  );
  await getQueue().add(
    ACCOUNT_PURGE_JOB,
    {},
    {
      jobId: ACCOUNT_PURGE_JOB,
      repeat: { every: ACCOUNT_PURGE_INTERVAL_MS },
      removeOnComplete: 20,
      removeOnFail: 20,
    },
  );
}

export async function getQueueCounts(): Promise<{
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
}> {
  const counts = await getQueue().getJobCounts("wait", "active", "delayed", "failed");
  return {
    waiting: counts.wait ?? 0,
    active: counts.active ?? 0,
    delayed: counts.delayed ?? 0,
    failed: counts.failed ?? 0,
  };
}

export async function pingRedis(): Promise<boolean> {
  const connection = createRedisConnection();
  try {
    await connection.ping();
    return true;
  } catch {
    return false;
  } finally {
    await connection.quit().catch(() => undefined);
  }
}

export async function closeQueue(): Promise<void> {
  await queue?.close();
  await queueEvents?.close();
  queue = null;
  queueEvents = null;
  if (queueConnection) {
    await queueConnection.quit();
    queueConnection = null;
  }
  if (eventsConnection) {
    await eventsConnection.quit();
    eventsConnection = null;
  }
}

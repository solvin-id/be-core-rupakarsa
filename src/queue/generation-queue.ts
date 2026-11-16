import { Queue, QueueEvents } from "bullmq";
import { Redis } from "ioredis";

import { env } from "../env.js";

export const GENERATION_QUEUE = "generation";

export interface RenderJobData {
  generationId: string;
  simulateFailure: boolean;
}

export type RenderJob = RenderJobData;

let queue: Queue<RenderJobData> | null = null;
let queueEvents: QueueEvents | null = null;
let queueConnection: Redis | null = null;
let eventsConnection: Redis | null = null;

export function createRedisConnection(): Redis {
  return new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
}

function getQueue(): Queue<RenderJobData> {
  if (!queue) {
    queueConnection = createRedisConnection();
    queue = new Queue<RenderJobData>(GENERATION_QUEUE, { connection: queueConnection });
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
    { removeOnComplete: 200, removeOnFail: 500, attempts: 1 },
  );
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

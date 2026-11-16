import { Queue } from "bullmq";

import { createRedisConnection } from "./generation-queue.js";

export const EMAIL_QUEUE = "email";

let queue: Queue<{ outboxId: string }> | null = null;
let connection: ReturnType<typeof createRedisConnection> | null = null;

function getQueue(): Queue<{ outboxId: string }> {
  if (!queue) {
    connection = createRedisConnection();
    queue = new Queue<{ outboxId: string }>(EMAIL_QUEUE, { connection });
  }
  return queue;
}

export async function enqueueEmail(outboxId: string): Promise<void> {
  await getQueue().add(
    "send",
    { outboxId },
    { removeOnComplete: 200, removeOnFail: { count: 500 }, attempts: 3, backoff: { type: "exponential", delay: 5000 } },
  );
}

export async function closeEmailQueue(): Promise<void> {
  await queue?.close();
  queue = null;
  if (connection) {
    await connection.quit();
    connection = null;
  }
}

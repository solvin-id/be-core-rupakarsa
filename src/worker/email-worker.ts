import { Worker } from "bullmq";

import { logger } from "../logger.js";
import { EMAIL_QUEUE } from "../queue/email-queue.js";
import { createRedisConnection } from "../queue/generation-queue.js";
import { deliverOutboxRow, retryPendingEmails } from "../services/mail-service.js";

const RETRY_INTERVAL_MS = 5 * 60_000;

/** Email sends run on their own BullMQ queue so a slow SMTP server never blocks renders. */
export function startEmailWorker(): { close: () => Promise<void> } {
  const connection = createRedisConnection();
  const worker = new Worker<{ outboxId: string }>(
    EMAIL_QUEUE,
    async (job) => {
      await deliverOutboxRow(job.data.outboxId);
    },
    { connection, concurrency: 2 },
  );

  worker.on("failed", (job, error) => {
    logger.error({ err: error, jobId: job?.id }, "email job failed");
  });

  const timer = setInterval(() => {
    void retryPendingEmails().catch((error: unknown) => {
      logger.warn({ err: error }, "email retry sweep failed");
    });
  }, RETRY_INTERVAL_MS);
  timer.unref();

  return {
    close: async () => {
      clearInterval(timer);
      await worker.close();
      await connection.quit();
    },
  };
}

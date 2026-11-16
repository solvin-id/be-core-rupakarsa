import { env } from "../env.js";
import {
  enqueueRender as enqueueQueue,
  closeQueue,
  getQueueCounts,
  pingRedis,
} from "./generation-queue.js";
import { enqueueRender as enqueueInline } from "./inline.js";

export type { RenderJob } from "./generation-queue.js";

export type EnqueueRender = (
  generationId: string,
  options: { simulateFailure: boolean },
) => Promise<void>;

/**
 * Both drivers are imported statically so bundling and type checking see them; the env flag only
 * picks which implementation runs. Redis connections are created lazily on first enqueue.
 */
export const enqueueRender: EnqueueRender =
  env.GENERATION_DRIVER === "inline" ? enqueueInline : enqueueQueue;

export { closeQueue, getQueueCounts, pingRedis };

import { logger } from "../logger.js";
import { renderGeneration } from "../worker/render-generation.js";

/**
 * Renders run in the background so an inline driver still behaves like the queue. The test harness
 * must not truncate tables under an in-flight render, so it awaits `settleInlineRenders` first.
 */
const inFlight = new Set<Promise<void>>();

export function settleInlineRenders(): Promise<void> {
  return Promise.all([...inFlight]).then(() => undefined);
}

export async function enqueueRender(
  generationId: string,
  options: { simulateFailure: boolean },
): Promise<void> {
  const task: Promise<void> = Promise.resolve()
    .then(() => renderGeneration({ generationId, simulateFailure: options.simulateFailure }))
    .catch((error: unknown) => {
      logger.error({ err: error, generationId }, "inline render failed");
    });
  inFlight.add(task);
  void task.then(
    () => inFlight.delete(task),
    () => inFlight.delete(task),
  );
}

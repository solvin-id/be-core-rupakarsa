import { logger } from "../logger.js";
import { renderGeneration } from "../worker/render-generation.js";

export async function enqueueRender(
  generationId: string,
  options: { simulateFailure: boolean },
): Promise<void> {
  queueMicrotask(() => {
    renderGeneration({ generationId, simulateFailure: options.simulateFailure }).catch((error) => {
      logger.error({ err: error, generationId }, "inline render failed");
    });
  });
}

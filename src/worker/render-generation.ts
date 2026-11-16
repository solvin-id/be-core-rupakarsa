import { eq } from "drizzle-orm";

import { db } from "../db/client.js";
import { generations } from "../db/schema.js";
import type { RenderJob } from "../queue/index.js";
import { getProviders } from "../providers/registry.js";
import { failGeneration, finalizeGeneration } from "../services/generation-service.js";

const RENDER_TIMEOUT_MS = 120_000;
const FALLBACK_ERROR = "Render gagal. Token dikembalikan otomatis.";

export async function renderGeneration(job: RenderJob): Promise<void> {
  const [generation] = await db
    .select()
    .from(generations)
    .where(eq(generations.id, job.generationId))
    .limit(1);

  if (!generation) return;
  if (generation.status === "COMPLETED" || generation.status === "FAILED") return;

  await db
    .update(generations)
    .set({ status: "RENDERING" })
    .where(eq(generations.id, generation.id));

  try {
    const result = await getProviders().render.render(
      {
        generationId: generation.id,
        prompt: generation.plannedPrompt || generation.rawPrompt,
        mediaType: generation.mediaType,
        modelName: generation.modelName,
        selectedParams: generation.selectedParams,
        simulateFailure: job.simulateFailure,
      },
      AbortSignal.timeout(RENDER_TIMEOUT_MS),
    );
    await finalizeGeneration(generation.id, result);
  } catch (error) {
    const message = error instanceof Error && error.message.length > 0 ? error.message : FALLBACK_ERROR;
    await failGeneration(generation.id, message);
  }
}

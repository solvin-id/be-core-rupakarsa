import type { PlanAdapter, PlanRequest, PlanResult } from "./types.js";
import { buildPlanBlueprint } from "../services/plan-blueprint.js";

export class StubPlanAdapter implements PlanAdapter {
  async plan(input: PlanRequest): Promise<PlanResult> {
    return buildPlanBlueprint({
      rawPrompt: input.rawPrompt,
      model: input.model,
      durationSec: input.durationSec,
      resolution: input.resolution,
      aspectRatio: input.aspectRatio,
      hasReference: input.hasReference,
    });
  }
}

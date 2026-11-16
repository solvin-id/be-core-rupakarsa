import { describe, expect, it } from "vitest";

import type { AiModelRow } from "../../src/db/schema.js";
import { buildPlanBlueprint } from "../../src/services/plan-blueprint.js";

function model(overrides: Partial<AiModelRow> = {}): AiModelRow {
  return {
    id: "00000000-0000-4000-8000-000000000999",
    providerId: "00000000-0000-4000-8000-000000000998",
    code: "wan-qwen-10s",
    displayName: "Wan Qwen 10s",
    mediaType: "VIDEO",
    allowedParams: { durations: [10], resolutions: ["1080p"], aspectRatios: ["16:9"] },
    tokenCost: 35,
    isActive: true,
    ...overrides,
  };
}

describe("plan blueprint", () => {
  it("builds a video prompt with camera, motion, duration and resolution blocks", () => {
    const blueprint = buildPlanBlueprint({
      rawPrompt: "  Rendang   steam, morning light ",
      model: model(),
      durationSec: 10,
      resolution: "1080p",
      aspectRatio: "16:9",
      hasReference: false,
    });

    expect(blueprint.prompt).toContain("[SUBJECT] Rendang steam, morning light");
    expect(blueprint.prompt).toContain("[CAMERA]");
    expect(blueprint.prompt).toContain("[MOTION]");
    expect(blueprint.prompt).toContain("Duration: 10 seconds.");
    expect(blueprint.prompt).toContain("Resolution: 1080p.");
    expect(blueprint.prompt).toContain("Aspect ratio: 16:9.");
    expect(blueprint.prompt).toContain("Model: Wan Qwen 10s.");
    expect(blueprint.prompt).not.toContain("[COMPOSITION]");
    expect(blueprint.direction.startsWith("Plan sinematik 10 seconds")).toBe(true);
    expect(blueprint.negativePrompt).toContain("blurry");
  });

  it("builds an image prompt without duration", () => {
    const blueprint = buildPlanBlueprint({
      rawPrompt: "Still life rempah",
      model: model({ mediaType: "IMAGE", displayName: "Flux Image" }),
      resolution: "2k",
      aspectRatio: "4:5",
      hasReference: true,
    });

    expect(blueprint.prompt).toContain("[COMPOSITION]");
    expect(blueprint.prompt).toContain("[DETAIL]");
    expect(blueprint.prompt).not.toContain("Duration:");
    expect(blueprint.prompt).toContain("Resolution: 2k.");
    expect(blueprint.prompt).toContain("Use the attached reference image");
    expect(blueprint.direction.startsWith("Plan still image 2k")).toBe(true);
  });

  it("keeps the negative prompt identical to the frontend builder", () => {
    const blueprint = buildPlanBlueprint({
      rawPrompt: "x",
      model: model(),
      durationSec: 10,
      resolution: "1080p",
      aspectRatio: "16:9",
      hasReference: false,
    });

    expect(blueprint.negativePrompt).toBe(
      "blurry, low resolution, distorted anatomy, extra fingers, warped faces, text artifacts, watermark, logo, oversaturated skin, plastic texture, flickering, jump cuts, inconsistent lighting",
    );
  });
});

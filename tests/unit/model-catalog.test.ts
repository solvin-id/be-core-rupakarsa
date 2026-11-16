import { describe, expect, it } from "vitest";

import { MODEL_TEMPLATES, findTemplate, templatesForProvider } from "../../src/services/model-catalog.js";

describe("model catalog", () => {
  it("carries nine templates", () => {
    expect(MODEL_TEMPLATES).toHaveLength(9);
  });

  it("exposes every template under the HIGGSFIELD provider", () => {
    expect(templatesForProvider("HIGGSFIELD")).toHaveLength(9);
    expect(templatesForProvider("KENARI_AI")).toHaveLength(0);
  });

  it("keeps the published token costs", () => {
    expect(findTemplate("HIGGSFIELD", "wan-qwen-10s")?.tokenCost).toBe(35);
    expect(findTemplate("HIGGSFIELD", "wan-qwen-5s")?.tokenCost).toBe(18);
    expect(findTemplate("HIGGSFIELD", "flux-image")?.tokenCost).toBe(2);
    expect(findTemplate("HIGGSFIELD", "kling-2.6-pro")?.tokenCost).toBe(42);
  });

  it("never ships an empty resolution or aspect-ratio list", () => {
    for (const template of MODEL_TEMPLATES) {
      expect(template.allowedParams.resolutions.length).toBeGreaterThan(0);
      expect(template.allowedParams.aspectRatios.length).toBeGreaterThan(0);
    }
  });
});

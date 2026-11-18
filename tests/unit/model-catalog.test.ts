import { describe, expect, it } from "vitest";

import { MODEL_TEMPLATES, findTemplate, templatesForProvider } from "../../src/services/model-catalog.js";

describe("model catalog", () => {
  it("carries the full thirteen-model catalog", () => {
    expect(MODEL_TEMPLATES).toHaveLength(13);
  });

  it("exposes every template under the HIGGSFIELD provider", () => {
    expect(templatesForProvider("HIGGSFIELD")).toHaveLength(13);
    expect(templatesForProvider("KENARI_AI")).toHaveLength(0);
  });

  it("keeps the published token costs", () => {
    expect(findTemplate("HIGGSFIELD", "wan-qwen-10s")?.tokenCost).toBe(35);
    expect(findTemplate("HIGGSFIELD", "wan-qwen-5s")?.tokenCost).toBe(18);
    expect(findTemplate("HIGGSFIELD", "flux-image")?.tokenCost).toBe(2);
    expect(findTemplate("HIGGSFIELD", "kling-2.6-pro")?.tokenCost).toBe(42);
  });

  it("declares Deep Thinking only for the Wan 3.0 workflows that accept it", () => {
    expect(findTemplate("HIGGSFIELD", "wan-qwen-10s")?.requestFields).toContain("thinking");
    expect(findTemplate("HIGGSFIELD", "wan-3.0-prime")?.requestFields).toContain("thinking");
    expect(findTemplate("HIGGSFIELD", "kling-2.6-pro")?.requestFields).not.toContain("thinking");
  });

  it("never ships an empty resolution or aspect-ratio list", () => {
    for (const template of MODEL_TEMPLATES) {
      expect(template.allowedParams.resolutions.length).toBeGreaterThan(0);
      expect(template.allowedParams.aspectRatios.length).toBeGreaterThan(0);
    }
  });
});

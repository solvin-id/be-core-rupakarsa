import { describe, expect, it } from "vitest";

import { slugify } from "../../src/services/slug.js";
import { uniqueSlug } from "../../src/services/workspace-service.js";

describe("slug helpers", () => {
  it("normalises a workspace name", () => {
    expect(slugify("My Studio!")).toBe("my-studio");
    expect(slugify("  Kampanye Rasa Nusantara  ")).toBe("kampanye-rasa-nusantara");
    expect(slugify("Alfateve___2026")).toBe("alfateve-2026");
  });

  it("keeps the base slug when it is free", () => {
    expect(uniqueSlug("demo", new Set())).toBe("demo");
  });

  it("appends incrementing suffixes for collisions", () => {
    expect(uniqueSlug("demo", new Set(["demo"]))).toBe("demo-2");
    expect(uniqueSlug("demo", new Set(["demo", "demo-2"]))).toBe("demo-3");
    expect(uniqueSlug("demo", new Set(["demo", "demo-2", "demo-3"]))).toBe("demo-4");
  });
});

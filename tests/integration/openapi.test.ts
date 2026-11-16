import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildOpenApiDocument } from "../../src/openapi/spec.js";

describe("openapi contract", () => {
  it("matches the committed openapi.json", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const file = resolve(here, "../../openapi.json");
    const committed = await readFile(file, "utf8");

    expect(buildOpenApiDocument()).toEqual(JSON.parse(committed));
  });

  it("documents every DTO the frontend consumes", () => {
    const document = buildOpenApiDocument();
    const schemas = Object.keys(document.components?.schemas ?? {});

    for (const name of [
      "User",
      "Workspace",
      "WorkspaceMembership",
      "SessionPayload",
      "WorkspacesPayload",
      "Folder",
      "FolderWithStats",
      "Generation",
      "AiModel",
      "AiProvider",
      "AdminContact",
      "PublicConfig",
    ]) {
      expect(schemas).toContain(name);
    }
  });
});

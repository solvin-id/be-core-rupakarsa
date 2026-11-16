import { beforeEach, describe, expect, it } from "vitest";

import { createAccount, createClient, createFolder, jsonBody, login, resetDatabase } from "./helpers.js";

describe("role-based access", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("blocks a plain creator account from the CMS", async () => {
    await createAccount({ email: "user@example.test" });
    const client = createClient();
    await login(client, "user@example.test");

    const response = await client.json<{ error: { code: string } }>("/api/cms/accounts");
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("lets an account with CMS access read the CMS", async () => {
    await createAccount({ email: "staff@example.test", cmsAccess: true });
    const client = createClient();
    await login(client, "staff@example.test");

    const response = await client.json<unknown[]>("/api/cms/accounts");
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
  });

  it("lets a superadmin read the CMS", async () => {
    await createAccount({ email: "root@example.test", role: "SUPERADMIN" });
    const client = createClient();
    await login(client, "root@example.test");

    const response = await client.json<unknown[]>("/api/cms/workspaces");
    expect(response.status).toBe(200);
  });

  it("hides folders of another workspace behind a 404", async () => {
    const owner = await createAccount({ email: "owner@example.test" });
    const intruder = await createAccount({ email: "intruder@example.test" });
    expect(intruder.workspace.id).not.toBe(owner.workspace.id);

    const ownerClient = createClient();
    await login(ownerClient, "owner@example.test");
    const folder = await createFolder(ownerClient, "Rahasia");

    const intruderClient = createClient();
    await login(intruderClient, "intruder@example.test");

    const generations = await intruderClient.json<{ error: { code: string } }>(
      `/api/creator/folders/${folder.id}/generations`,
    );
    expect(generations.status).toBe(404);

    const patch = await intruderClient.json<{ error: { code: string } }>(
      `/api/creator/folders/${folder.id}`,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Curian" }) },
    );
    expect(patch.status).toBe(404);

    const generation = await intruderClient.json<{ error: { code: string } }>(
      "/api/creator/generations",
      {
        ...jsonBody({
          folderId: folder.id,
          modelId: "00000000-0000-4000-8000-000000000000",
          rawPrompt: "x",
          plannedPrompt: "y",
          selectedParams: { resolution: "1080p", aspectRatio: "16:9", durationSec: 10 },
        }),
      },
    );
    expect(generation.status).toBe(404);
  });
});

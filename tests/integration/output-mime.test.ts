import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "../../src/db/client.js";
import { generations, workspaces } from "../../src/db/schema.js";
import { finalizeGeneration } from "../../src/services/generation-service.js";
import { signMediaUrl } from "../../src/services/storage-service.js";
import {
  createAccount,
  createClient,
  createFolder,
  jsonBody,
  login,
  modelByCode,
  resetDatabase,
} from "./helpers.js";

/** Unclassifiable body: no `ftyp` box, so the adapter's claim is the only signal. */
const UNCLASSIFIABLE = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x00, 0x01, 0x02, 0x03]);

async function fixture(email: string) {
  const account = await createAccount({ email });
  await db.update(workspaces).set({ tokenBalance: 100 }).where(eq(workspaces.id, account.workspace.id));
  const client = createClient();
  await login(client, email);
  const folder = await createFolder(client, "Mime");
  return { client, workspaceId: account.workspace.id, folderId: folder.id };
}

describe("finalize output mime", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("stores an octet-stream video as mp4 and serves it with that content type", async () => {
    const fx = await fixture("mime@example.test");
    const model = await modelByCode("wan-qwen-10s");

    const created = await fx.client.json<{ generation: { id: string } }>(
      "/api/creator/generations",
      jsonBody({
        folderId: fx.folderId,
        modelId: model.id,
        rawPrompt: "Gelombang",
        planMode: true,
        finalPrompt: "Slow cinematic waves",
        attachmentKeys: [],
        selectedParams: { durationSec: 10, resolution: "1080p", aspectRatio: "16:9" },
      }),
    );
    expect(created.status).toBe(201);
    const generationId = created.body.generation.id;

    // The inline worker already finished this render; reset the row to finalize it again with a
    // provider that reports the generic content type.
    await db
      .update(generations)
      .set({ status: "RENDERING", outputKey: null, outputMime: null, completedAt: null })
      .where(eq(generations.id, generationId));

    await finalizeGeneration(generationId, {
      bytes: UNCLASSIFIABLE,
      mime: "application/octet-stream",
      externalJobId: "mime-job-1",
      durationSec: 10,
    });

    const [row] = await db
      .select()
      .from(generations)
      .where(eq(generations.id, generationId))
      .limit(1);
    expect(row?.status).toBe("COMPLETED");
    expect(row?.outputMime).toBe("video/mp4");
    expect(row?.outputKey?.endsWith(".mp4")).toBe(true);

    const key = row?.outputKey ?? "";
    const url = new URL(signMediaUrl(key, 3600));
    const media = await createClient().request(`${url.pathname}${url.search}`);
    expect(media.status).toBe(200);
    expect(media.headers.get("content-type")).toBe("video/mp4");
    await media.body?.cancel();

    const fetched = await fx.client.json<{ outputUrl: string | null; outputMime: string | null }>(
      `/api/creator/generations/${generationId}`,
    );
    expect(fetched.body.outputMime).toBe("video/mp4");
    expect(fetched.body.outputUrl).toContain(".mp4");
  });
});

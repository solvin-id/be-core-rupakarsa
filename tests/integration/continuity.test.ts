import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "../../src/db/client.js";
import { aiModels, generationAttachments, generations, workspaces } from "../../src/db/schema.js";
import { putAsset, signMediaUrl } from "../../src/services/storage-service.js";
import {
  createAccount,
  createClient,
  createFolder,
  jsonBody,
  login,
  modelByCode,
  resetDatabase,
} from "./helpers.js";

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function fixture(email: string) {
  const account = await createAccount({ email });
  await db.update(workspaces).set({ tokenBalance: 100 }).where(eq(workspaces.id, account.workspace.id));
  const client = createClient();
  await login(client, email);
  const folder = await createFolder(client, "Film Pendek");
  return { client, workspaceId: account.workspace.id, folderId: folder.id };
}

/** A finished scene with a stored output, which is what continuity reads. */
async function seedPreviousScene(
  workspaceId: string,
  folderId: string,
  modelId: string,
  overrides: { sequence?: number; plannedPrompt?: string; analysisSnapshot?: string } = {},
) {
  const key = `workspaces/${workspaceId}/generations/${crypto.randomUUID()}.png`;
  await putAsset(workspaceId, key, PNG_BYTES, "image/png");

  const [row] = await db
    .insert(generations)
    .values({
      workspaceId,
      folderId,
      modelId,
      modelName: "Scene One",
      mediaType: "IMAGE",
      rawPrompt: "Mbok Srini menutup pintu",
      plannedPrompt:
        overrides.plannedPrompt ??
        "Mbok Srini closes the heavy teak door, lantern light spilling on the stone floor.",
      finalPrompt: "Mbok Srini closes the heavy teak door.",
      analysisSnapshot:
        overrides.analysisSnapshot ??
        "Subject: elderly Javanese woman in batik. Palette: amber and cold stone.",
      selectedParams: { resolution: "1k", aspectRatio: "1:1" },
      status: "COMPLETED",
      sequence: overrides.sequence ?? 1,
      outputKey: key,
      completedAt: new Date(),
    })
    .returning();
  if (!row) throw new Error("failed to seed the previous scene");
  return { row, key };
}

function generationBody(input: {
  folderId: string;
  modelId: string;
  rawPrompt: string;
  chainSceneIds?: string[];
}) {
  return jsonBody({
    folderId: input.folderId,
    modelId: input.modelId,
    rawPrompt: input.rawPrompt,
    planMode: false,
    finalPrompt: null,
    attachmentKeys: [],
    contextIds: [],
    selectedParams: { resolution: "1k", aspectRatio: "1:1" },
    ...(input.chainSceneIds === undefined ? {} : { chainSceneIds: input.chainSceneIds }),
  });
}

describe("scene continuity", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("carries the previous scene into the prompt and reuses its output as the reference", async () => {
    const fx = await fixture("continuity@example.test");
    const model = await modelByCode("flux-image");
    // Only a workflow that declares the single-image field may receive a reference.
    await db
      .update(aiModels)
      .set({ syncMetadata: { requestFields: ["resolution", "aspectRatio", "image"] } })
      .where(eq(aiModels.id, model.id));

    const previous = await seedPreviousScene(fx.workspaceId, fx.folderId, model.id);

    const created = await fx.client.json<{ generation: { id: string } }>(
      "/api/creator/generations",
      generationBody({
        folderId: fx.folderId,
        modelId: model.id,
        rawPrompt: "Dia berjalan ke koridor",
        chainSceneIds: [previous.row.id],
      }),
    );
    expect(created.status).toBe(201);

    const [row] = await db
      .select()
      .from(generations)
      .where(eq(generations.id, created.body.generation.id))
      .limit(1);

    expect(row?.finalPrompt).toContain("[SCENE 1]");
    expect(row?.finalPrompt).toContain("[STYLE LOCK]");
    expect(row?.finalPrompt).toContain("Mbok Srini closes the heavy teak door");
    expect(row?.referenceImageUrl).toBe(previous.key);
    expect(row?.sequence).toBe(2);
    expect(row?.continuitySourceId).toBe(previous.row.id);
    expect(row?.preContextSnapshot).toContain("[SCENE DIRECTION]");

    const attachments = await db
      .select()
      .from(generationAttachments)
      .where(
        and(
          eq(generationAttachments.generationId, created.body.generation.id),
          eq(generationAttachments.role, "CONTINUITY"),
        ),
      );
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.sourceGenerationId).toBe(previous.row.id);
  });

  it("starts a fresh scene when no scene is selected", async () => {
    const fx = await fixture("continuity-off@example.test");
    const model = await modelByCode("flux-image");
    await db
      .update(aiModels)
      .set({ syncMetadata: { requestFields: ["resolution", "aspectRatio", "image"] } })
      .where(eq(aiModels.id, model.id));

    await seedPreviousScene(fx.workspaceId, fx.folderId, model.id);

    const created = await fx.client.json<{ generation: { id: string } }>(
      "/api/creator/generations",
      generationBody({
        folderId: fx.folderId,
        modelId: model.id,
        rawPrompt: "Adegan baru di pasar",
      }),
    );
    expect(created.status).toBe(201);

    const [row] = await db
      .select()
      .from(generations)
      .where(eq(generations.id, created.body.generation.id))
      .limit(1);

    expect(row?.finalPrompt).not.toContain("[SCENE 1]");
    expect(row?.finalPrompt).not.toContain("[SCENE DIRECTION]");
    expect(row?.finalPrompt).not.toContain("[STYLE LOCK]");
    expect(row?.referenceImageUrl).toBeNull();
    expect(row?.continuitySourceId).toBeNull();
    // The scene counter still advances: this is scene two of the folder, just not a continuation.
    expect(row?.sequence).toBe(2);

    const attachments = await db
      .select()
      .from(generationAttachments)
      .where(eq(generationAttachments.generationId, created.body.generation.id));
    expect(attachments).toHaveLength(0);
  });

  it("chains every selected scene and references the newest one", async () => {
    const fx = await fixture("continuity-chain@example.test");
    const model = await modelByCode("flux-image");
    await db
      .update(aiModels)
      .set({ syncMetadata: { requestFields: ["resolution", "aspectRatio", "image"] } })
      .where(eq(aiModels.id, model.id));

    const first = await seedPreviousScene(fx.workspaceId, fx.folderId, model.id, {
      sequence: 1,
      plannedPrompt: "Mbok Srini membuka pintu kayu.",
      analysisSnapshot: "Palette: amber. Wardrobe: batik.",
    });
    const second = await seedPreviousScene(fx.workspaceId, fx.folderId, model.id, {
      sequence: 2,
      plannedPrompt: "Mbok Srini menuruni tangga batu.",
      analysisSnapshot: "Palette: cold blue. Lens: 35mm.",
    });

    const created = await fx.client.json<{ generation: { id: string } }>(
      "/api/creator/generations",
      generationBody({
        folderId: fx.folderId,
        modelId: model.id,
        rawPrompt: "Dia menyalakan lampu",
        chainSceneIds: [second.row.id, first.row.id],
      }),
    );
    expect(created.status).toBe(201);

    const [row] = await db
      .select()
      .from(generations)
      .where(eq(generations.id, created.body.generation.id))
      .limit(1);

    expect(row?.preContextSnapshot).toContain("[SCENE 1]");
    expect(row?.preContextSnapshot).toContain("[SCENE 2]");
    expect(row?.preContextSnapshot).toContain("Mbok Srini membuka pintu kayu.");
    expect(row?.preContextSnapshot).toContain("Mbok Srini menuruni tangga batu.");
    // Exactly one direction block closes the chain, regardless of how many scenes were selected.
    expect(row?.preContextSnapshot?.match(/\[SCENE DIRECTION\]/g)).toHaveLength(1);
    expect(row?.continuitySourceId).toBe(second.row.id);
    expect(row?.referenceImageUrl).toBe(second.key);
  });

  it("returns the previous scene through the media route as a signed URL", async () => {
    const fx = await fixture("continuity-media@example.test");
    const model = await modelByCode("flux-image");
    const previous = await seedPreviousScene(fx.workspaceId, fx.folderId, model.id);

    const url = signMediaUrl(previous.key, 3600);
    const media = await createClient().request(new URL(url).pathname + new URL(url).search);
    expect(media.status).toBe(200);
    expect(media.headers.get("content-type")).toBe("image/png");
    await media.body?.cancel();
  });
});

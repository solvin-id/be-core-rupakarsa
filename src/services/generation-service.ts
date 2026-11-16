import { and, eq } from "drizzle-orm";

import { db } from "../db/client.js";
import { aiModels, folders, generations, mediaAssets, workspaces } from "../db/schema.js";
import type { AiModelRow, FolderRow, GenerationParams, GenerationRow, WorkspaceRow } from "../db/schema.js";
import { AppError, conflict, notFound, validation } from "../http/errors.js";
import { getProviders } from "../providers/registry.js";
import { toWorkspace } from "../http/serialize.js";
import type { WorkspaceDto } from "../http/schemas.js";
import { getStorage } from "../storage/index.js";
import { getPricing } from "./settings.js";
import { commitHold, consumePlanQuota, holdTokens, refundHold } from "./token-service.js";
import { enqueueRender } from "../queue/index.js";

const MAX_RAW_PROMPT = 2000;
const MAX_PLANNED_PROMPT = 8000;

export interface PlanGenerationInput {
  workspaceId: string;
  userId: string;
  modelId: string;
  rawPrompt: string;
  durationSec?: number;
  resolution: string;
  aspectRatio: string;
  hasReference: boolean;
}

export interface PlanGenerationResult {
  blueprint: { prompt: string; direction: string; negativePrompt: string };
  cost: { tokens: number; usesFreeQuota: boolean };
  workspace: WorkspaceDto;
}

export interface CreateGenerationInput {
  workspaceId: string;
  userId: string;
  folderId: string;
  modelId: string;
  rawPrompt: string;
  plannedPrompt: string;
  referenceImageUrl: string | null;
  selectedParams: GenerationParams;
  simulateFailure: boolean;
}

export interface CreateGenerationResult {
  generation: GenerationRow;
  workspace: WorkspaceDto;
}

async function loadModel(modelId: string): Promise<AiModelRow> {
  const [model] = await db.select().from(aiModels).where(eq(aiModels.id, modelId)).limit(1);
  if (!model) throw notFound("Model tidak ditemukan.");
  if (!model.isActive) throw conflict("Model ini sedang tidak aktif.");
  return model;
}

export function assertParamsAllowed(model: AiModelRow, params: GenerationParams): void {
  const { durations, resolutions, aspectRatios } = model.allowedParams;
  if (!resolutions.includes(params.resolution)) {
    throw validation(`Resolusi ${params.resolution} tidak tersedia untuk model ini.`);
  }
  if (!aspectRatios.includes(params.aspectRatio)) {
    throw validation(`Rasio aspek ${params.aspectRatio} tidak tersedia untuk model ini.`);
  }
  if (model.mediaType === "VIDEO") {
    if (params.durationSec === undefined) {
      throw validation("Durasi wajib dipilih untuk model video.");
    }
    if (!durations || !durations.includes(params.durationSec)) {
      throw validation(`Durasi ${params.durationSec}s tidak tersedia untuk model ini.`);
    }
  } else if (params.durationSec !== undefined) {
    throw validation("Model gambar tidak menerima durasi.");
  }
}

async function loadFolder(workspaceId: string, folderId: string): Promise<FolderRow> {
  const [folder] = await db
    .select()
    .from(folders)
    .where(and(eq(folders.id, folderId), eq(folders.workspaceId, workspaceId)))
    .limit(1);
  if (!folder) throw notFound("Folder tidak ditemukan.");
  return folder;
}

async function referenceIsKnown(userId: string, url: string): Promise<boolean> {
  const marker = "/media/";
  const index = url.indexOf(marker);
  if (index < 0) return false;
  const key = url.slice(index + marker.length).split("?")[0] ?? "";
  if (key.length === 0) return false;

  const [asset] = await db
    .select({ id: mediaAssets.id, uploadedBy: mediaAssets.uploadedBy })
    .from(mediaAssets)
    .where(eq(mediaAssets.key, key))
    .limit(1);
  return asset?.uploadedBy === userId;
}

async function workspaceSnapshot(workspaceId: string): Promise<WorkspaceRow> {
  const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (!row) throw notFound("Workspace tidak ditemukan.");
  return row;
}

export async function planGeneration(input: PlanGenerationInput): Promise<PlanGenerationResult> {
  if (input.rawPrompt.trim().length === 0 || input.rawPrompt.length > MAX_RAW_PROMPT) {
    throw validation(`Brief maksimal ${MAX_RAW_PROMPT} karakter dan tidak boleh kosong.`);
  }
  const model = await loadModel(input.modelId);
  assertParamsAllowed(model, {
    durationSec: input.durationSec,
    resolution: input.resolution,
    aspectRatio: input.aspectRatio,
  });

  const blueprint = await getProviders().plan.plan({
    rawPrompt: input.rawPrompt,
    model,
    durationSec: input.durationSec,
    resolution: input.resolution,
    aspectRatio: input.aspectRatio,
    hasReference: input.hasReference,
  });

  const pricing = await getPricing(db);
  const outcome = await db.transaction(async (tx) => {
    const cost = await consumePlanQuota(tx, {
      workspaceId: input.workspaceId,
      userId: input.userId,
      planModeTokenCost: pricing.planModeTokenCost,
    });
    const [workspace] = await tx
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, input.workspaceId))
      .limit(1);
    if (!workspace) throw notFound("Workspace tidak ditemukan.");
    return { cost, workspace };
  });

  return { blueprint, cost: outcome.cost, workspace: toWorkspace(outcome.workspace) };
}

export async function createGeneration(input: CreateGenerationInput): Promise<CreateGenerationResult> {
  if (input.rawPrompt.trim().length === 0 || input.rawPrompt.length > MAX_RAW_PROMPT) {
    throw validation(`Brief maksimal ${MAX_RAW_PROMPT} karakter dan tidak boleh kosong.`);
  }
  if (input.plannedPrompt.trim().length === 0 || input.plannedPrompt.length > MAX_PLANNED_PROMPT) {
    throw validation(`Planned prompt maksimal ${MAX_PLANNED_PROMPT} karakter dan tidak boleh kosong.`);
  }

  const folder = await loadFolder(input.workspaceId, input.folderId);
  const model = await loadModel(input.modelId);
  assertParamsAllowed(model, input.selectedParams);

  if (input.referenceImageUrl !== null) {
    const known = await referenceIsKnown(input.userId, input.referenceImageUrl);
    if (!known) throw validation("Gambar referensi tidak dikenal.");
  }

  const created = await db.transaction(async (tx) => {
    const generationId = crypto.randomUUID();

    const [generation] = await tx
      .insert(generations)
      .values({
        id: generationId,
        workspaceId: input.workspaceId,
        folderId: folder.id,
        userId: input.userId,
        modelId: model.id,
        modelName: model.displayName,
        mediaType: model.mediaType,
        rawPrompt: input.rawPrompt,
        plannedPrompt: input.plannedPrompt,
        referenceImageUrl: input.referenceImageUrl,
        selectedParams: input.selectedParams,
        tokensCharged: model.tokenCost,
        status: "QUEUED",
        externalJobId: null,
        outputUrl: null,
        errorMessage: null,
        refunded: false,
        completedAt: null,
      })
      .returning();
    if (!generation) throw new AppError(500, "INTERNAL", "Gagal membuat generation.");

    await holdTokens(tx, {
      workspaceId: input.workspaceId,
      userId: input.userId,
      amount: model.tokenCost,
      generationId,
    });

    const [workspace] = await tx
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, input.workspaceId))
      .limit(1);
    if (!workspace) throw notFound("Workspace tidak ditemukan.");

    return { generation, workspace };
  });

  try {
    await enqueueRender(created.generation.id, { simulateFailure: input.simulateFailure });
  } catch {
    await db.transaction(async (tx) => {
      await refundHold(tx, {
        workspaceId: input.workspaceId,
        userId: input.userId,
        generationId: created.generation.id,
        amount: created.generation.tokensCharged,
      });
      await tx
        .update(generations)
        .set({
          status: "FAILED",
          refunded: true,
          errorMessage: "Antrean render tidak tersedia. Token dikembalikan otomatis.",
          completedAt: new Date(),
        })
        .where(eq(generations.id, created.generation.id));
    });
    throw new AppError(503, "QUEUE_UNAVAILABLE", "Antrean render tidak tersedia. Coba lagi.");
  }

  return {
    generation: created.generation,
    workspace: toWorkspace(await workspaceSnapshot(created.workspace.id)),
  };
}

export async function finalizeGeneration(
  generationId: string,
  outcome: { outputKey: string; externalJobId: string },
): Promise<void> {
  const storage = getStorage();
  await db.transaction(async (tx) => {
    const [generation] = await tx
      .select()
      .from(generations)
      .where(eq(generations.id, generationId))
      .for("update")
      .limit(1);
    if (!generation || generation.status === "COMPLETED" || generation.status === "FAILED") return;

    await tx
      .insert(mediaAssets)
      .values({
        key: outcome.outputKey,
        mime: "image/svg+xml",
        size: 0,
        uploadedBy: generation.userId,
      })
      .onConflictDoNothing({ target: mediaAssets.key });

    await tx
      .update(generations)
      .set({
        status: "COMPLETED",
        outputUrl: storage.url(outcome.outputKey),
        externalJobId: outcome.externalJobId,
        errorMessage: null,
        completedAt: new Date(),
      })
      .where(eq(generations.id, generationId));

    await commitHold(tx, {
      workspaceId: generation.workspaceId,
      userId: generation.userId,
      generationId: generation.id,
      amount: generation.tokensCharged,
    });
  });
}

export async function failGeneration(generationId: string, message: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [generation] = await tx
      .select()
      .from(generations)
      .where(eq(generations.id, generationId))
      .for("update")
      .limit(1);
    if (!generation || generation.status === "COMPLETED" || generation.status === "FAILED") return;

    await tx
      .update(generations)
      .set({
        status: "FAILED",
        refunded: true,
        errorMessage: message,
        completedAt: new Date(),
      })
      .where(eq(generations.id, generationId));

    await refundHold(tx, {
      workspaceId: generation.workspaceId,
      userId: generation.userId,
      generationId: generation.id,
      amount: generation.tokensCharged,
    });
  });
}

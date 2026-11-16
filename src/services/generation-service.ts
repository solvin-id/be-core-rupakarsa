import { and, eq, inArray, sql } from "drizzle-orm";

import type { RenderResult } from "../adapters/types.js";
import { db } from "../db/client.js";
import {
  aiModels,
  folders,
  generationAttachments,
  generations,
  mediaAssets,
  users,
  workspaces,
} from "../db/schema.js";
import type {
  AiModelRow,
  FolderRow,
  GenerationParams,
  GenerationRow,
  MediaAssetRow,
  WorkspaceRow,
} from "../db/schema.js";
import { AppError, conflict, notFound, validation } from "../http/errors.js";
import { toWorkspace } from "../http/serialize.js";
import type { WorkspaceDto } from "../http/schemas.js";
import { getPlanModelAdapter } from "../providers/registry.js";
import { enqueueRender } from "../queue/index.js";
import { analyzeAsset } from "./analysis-service.js";
import type { PlanAttachment } from "./plan-service.js";
import { assertAttachmentsSupported, runPlanModel } from "./plan-service.js";
import { loadContextText } from "./pre-context-service.js";
import { assertDailyGenerationQuota } from "./quota-service.js";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { queueMail } from "./mail-service.js";
import { getMailSettings, getPricing } from "./settings.js";
import { putAsset, urlForAsset } from "./storage-service.js";
import { commitHold, consumePlanQuota, holdTokens, refundHold } from "./token-service.js";

const MAX_RAW_PROMPT = 2000;
const MAX_PLANNED_PROMPT = 8000;
const MAX_ATTACHMENTS = 4;

export interface PlanGenerationInput {
  workspaceId: string;
  userId: string;
  folderId: string;
  modelId: string;
  rawPrompt: string;
  durationSec?: number;
  resolution: string;
  aspectRatio: string;
  attachmentKeys: string[];
  contextIds?: string[];
}

export interface PlanGenerationResult {
  blueprint: { prompt: string; direction: string; negativePrompt: string };
  cost: { tokens: number; usesFreeQuota: boolean };
  workspace: WorkspaceDto;
  analysis: { attachments: { key: string; text: string }[]; preContext: string };
}

export interface CreateGenerationInput {
  workspaceId: string;
  userId: string;
  folderId: string;
  modelId: string;
  rawPrompt: string;
  planMode: boolean;
  finalPrompt: string | null;
  attachmentKeys: string[];
  contextIds: string[];
  selectedParams: GenerationParams;
  simulateFailure: boolean;
}

export interface CreateGenerationResult {
  generation: GenerationRow;
  workspace: WorkspaceDto;
}

interface ResolvedAttachment {
  asset: MediaAssetRow;
  kind: "IMAGE" | "VIDEO";
  url: string;
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

/** Resolves uploaded attachment keys into this workspace's assets, preserving the given order. */
async function loadAttachments(
  workspaceId: string,
  userId: string,
  keys: string[],
): Promise<ResolvedAttachment[]> {
  const unique = [...new Set(keys.filter((key) => key.trim().length > 0))];
  if (unique.length === 0) return [];
  if (unique.length > MAX_ATTACHMENTS) {
    throw validation(`Lampiran maksimal ${MAX_ATTACHMENTS} berkas.`);
  }

  const rows = await db.select().from(mediaAssets).where(inArray(mediaAssets.key, unique));
  const byKey = new Map(rows.map((row) => [row.key, row]));

  const resolved: ResolvedAttachment[] = [];
  for (const key of unique) {
    const asset = byKey.get(key);
    if (!asset) throw validation("Lampiran tidak dikenal.");
    if (asset.workspaceId && asset.workspaceId !== workspaceId) throw validation("Lampiran tidak dikenal.");
    if (asset.uploadedBy && asset.uploadedBy !== userId) throw validation("Lampiran tidak dikenal.");
    if (asset.purgedAt) throw validation("Lampiran sudah dibersihkan dari storage.");

    const kind: "IMAGE" | "VIDEO" = asset.mime.startsWith("video/") ? "VIDEO" : "IMAGE";
    resolved.push({ asset, kind, url: await urlForAsset(asset) });
  }
  return resolved;
}

async function workspaceSnapshot(workspaceId: string): Promise<WorkspaceRow> {
  const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (!row) throw notFound("Workspace tidak ditemukan.");
  return row;
}

/**
 * Capability gate for the plan model. When no plan model is configured the deterministic blueprint
 * applies: attachments are ignored (and never analyzed) so the studio stays usable before AI
 * settings exist.
 */
async function planModelForAttachments(attachments: PlanAttachment[]): Promise<boolean> {
  const { model } = await getPlanModelAdapter();
  if (!model) return false;
  assertAttachmentsSupported(model, attachments);
  return true;
}

function planAttachmentsOf(resolved: ResolvedAttachment[]): PlanAttachment[] {
  return resolved.map((item) => ({ url: item.url, kind: item.kind }));
}

export async function planGeneration(input: PlanGenerationInput): Promise<PlanGenerationResult> {
  if (input.rawPrompt.trim().length === 0 || input.rawPrompt.length > MAX_RAW_PROMPT) {
    throw validation(`Brief maksimal ${MAX_RAW_PROMPT} karakter dan tidak boleh kosong.`);
  }
  const folder = await loadFolder(input.workspaceId, input.folderId);
  const model = await loadModel(input.modelId);
  assertParamsAllowed(model, {
    durationSec: input.durationSec,
    resolution: input.resolution,
    aspectRatio: input.aspectRatio,
  });

  const resolved = await loadAttachments(input.workspaceId, input.userId, input.attachmentKeys);
  const planModelEnabled = await planModelForAttachments(planAttachmentsOf(resolved));

  const analyses = planModelEnabled
    ? await Promise.all(
        resolved.map(async (item) => ({
          key: item.asset.key,
          analysis: await analyzeAsset(input.workspaceId, { mediaAssetId: item.asset.id }),
        })),
      )
    : [];
  const contextText = await loadContextText(db, folder.id, input.contextIds);

  const plan = await runPlanModel({
    workspaceId: input.workspaceId,
    folderId: folder.id,
    renderModel: model,
    rawPrompt: input.rawPrompt,
    attachmentTexts: analyses.map((entry) => entry.analysis.text),
    attachments: planAttachmentsOf(resolved),
    contextText,
    selectedParams: {
      durationSec: input.durationSec,
      resolution: input.resolution,
      aspectRatio: input.aspectRatio,
    },
    hasReference: resolved.length > 0,
    mode: "plan",
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

  return {
    blueprint: {
      prompt: plan.prompt,
      direction: plan.direction,
      negativePrompt: plan.negativePrompt,
    },
    cost: outcome.cost,
    workspace: toWorkspace(outcome.workspace),
    analysis: {
      attachments: analyses.map((entry) => ({ key: entry.key, text: entry.analysis.text })),
      preContext: contextText,
    },
  };
}

export async function createGeneration(input: CreateGenerationInput): Promise<CreateGenerationResult> {
  if (input.rawPrompt.trim().length === 0 || input.rawPrompt.length > MAX_RAW_PROMPT) {
    throw validation(`Brief maksimal ${MAX_RAW_PROMPT} karakter dan tidak boleh kosong.`);
  }

  const folder = await loadFolder(input.workspaceId, input.folderId);
  const model = await loadModel(input.modelId);
  assertParamsAllowed(model, input.selectedParams);
  await assertDailyGenerationQuota(input.workspaceId);

  const resolved = await loadAttachments(input.workspaceId, input.userId, input.attachmentKeys);
  const planModelEnabled = await planModelForAttachments(planAttachmentsOf(resolved));

  const analyses = planModelEnabled
    ? await Promise.all(
        resolved.map(async (item) => ({
          asset: item.asset,
          text: (await analyzeAsset(input.workspaceId, { mediaAssetId: item.asset.id })).text,
        })),
      )
    : [];
  const contextText = await loadContextText(db, folder.id, input.contextIds);

  let finalPrompt = input.finalPrompt?.trim() ?? "";
  if (input.planMode) {
    if (finalPrompt.length === 0) throw validation("Buat plan terlebih dahulu.");
  } else if (finalPrompt.length === 0) {
    const direct = await runPlanModel({
      workspaceId: input.workspaceId,
      folderId: folder.id,
      renderModel: model,
      rawPrompt: input.rawPrompt,
      attachmentTexts: analyses.map((entry) => entry.text),
      attachments: planAttachmentsOf(resolved),
      contextText,
      selectedParams: input.selectedParams,
      hasReference: resolved.length > 0,
      mode: "direct",
    });
    finalPrompt = direct.prompt.trim();
  }

  if (finalPrompt.length === 0 || finalPrompt.length > MAX_PLANNED_PROMPT) {
    throw validation(`Planned prompt maksimal ${MAX_PLANNED_PROMPT} karakter dan tidak boleh kosong.`);
  }

  const firstAttachment = resolved[0] ?? null;
  const analysisSnapshot = analyses
    .map((entry) => `# ${entry.asset.key}\n${entry.text}`)
    .join("\n\n");

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
        plannedPrompt: finalPrompt,
        planMode: input.planMode,
        finalPrompt,
        analysisSnapshot,
        preContextSnapshot: contextText,
        referenceImageUrl: firstAttachment ? firstAttachment.asset.key : null,
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

    if (analyses.length > 0) {
      await tx.insert(generationAttachments).values(
        analyses.map((entry) => ({
          generationId,
          role: "REFERENCE" as const,
          mediaAssetId: entry.asset.id,
          analysisText: entry.text,
        })),
      );
    }

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

const MIME_EXTENSIONS: Record<string, string> = {
  "image/svg+xml": "svg",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

export function extensionForMime(mime: string): string {
  return MIME_EXTENSIONS[mime] ?? "bin";
}

/** Key layout: `workspaces/<id>/generations/<generationId>.<ext>` — public and immutable. */
export function generationOutputKey(workspaceId: string, generationId: string, mime: string): string {
  return `workspaces/${workspaceId}/generations/${generationId}.${extensionForMime(mime)}`;
}

/** Render outcome mail is best-effort and only sent when SMTP is configured. */
async function notifyRenderOutcome(
  generation: GenerationRow,
  status: "COMPLETED" | "FAILED",
  errorMessage?: string,
): Promise<void> {
  try {
    const settings = await getMailSettings(db);
    if (settings.driver !== "smtp" || !generation.userId) return;
    const [user] = await db.select().from(users).where(eq(users.id, generation.userId)).limit(1);
    if (!user) return;
    await queueMail({
      to: user.email,
      template: "RENDER_COMPLETED",
      data: {
        modelName: generation.modelName,
        status,
        errorMessage: errorMessage ?? "",
        studioUrl: `${env.PUBLIC_CREATOR_URL}/app/projects/${generation.folderId}`,
      },
    });
  } catch (error) {
    logger.warn({ err: error, generationId: generation.id }, "render outcome mail failed");
  }
}

export async function finalizeGeneration(
  generationId: string,
  outcome: RenderResult,
): Promise<void> {
  const [generation] = await db
    .select()
    .from(generations)
    .where(eq(generations.id, generationId))
    .limit(1);
  if (!generation || generation.status === "COMPLETED" || generation.status === "FAILED") return;

  const key = generationOutputKey(generation.workspaceId, generation.id, outcome.mime);
  const { url } = await putAsset(generation.workspaceId, key, outcome.bytes, outcome.mime, {
    uploadedBy: generation.userId,
    durationMs: outcome.durationSec ? Math.round(outcome.durationSec * 1000) : null,
    width: outcome.width ?? null,
    height: outcome.height ?? null,
  });

  await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(generations)
      .where(eq(generations.id, generationId))
      .for("update")
      .limit(1);
    if (!locked || locked.status === "COMPLETED" || locked.status === "FAILED") return;

    await tx
      .update(generations)
      .set({
        status: "COMPLETED",
        outputUrl: url,
        outputMime: outcome.mime,
        outputSize: outcome.bytes.byteLength,
        externalJobId: outcome.externalJobId,
        errorMessage: null,
        completedAt: new Date(),
      })
      .where(eq(generations.id, generationId));

    await commitHold(tx, {
      workspaceId: locked.workspaceId,
      userId: locked.userId,
      generationId: locked.id,
      amount: locked.tokensCharged,
    });
  });

  await notifyRenderOutcome(generation, "COMPLETED");
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

  const [failed] = await db
    .select()
    .from(generations)
    .where(eq(generations.id, generationId))
    .limit(1);
  if (failed) await notifyRenderOutcome(failed, "FAILED", message);
}

/**
 * Maps generation id to the purge timestamp of its rendered asset so list endpoints can hide
 * download affordances for media the retention sweeper already removed.
 */
export async function purgedMapFor(generationIds: string[]): Promise<Map<string, Date | null>> {
  const map = new Map<string, Date | null>();
  if (generationIds.length === 0) return map;

  const pattern = `(${generationIds.join("|")})`;
  const rows = await db
    .select({ key: mediaAssets.key, purgedAt: mediaAssets.purgedAt })
    .from(mediaAssets)
    .where(sql`${mediaAssets.key} ~ ${pattern}`);

  for (const id of generationIds) {
    const hit = rows.find((row) => row.key.includes(id));
    map.set(id, hit?.purgedAt ?? null);
  }
  return map;
}

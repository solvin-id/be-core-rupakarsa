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
import { modelSupportsImageReference } from "./model-capabilities.js";
import type { PlanAttachment } from "./plan-service.js";
import { assertAttachmentsSupported, buildDirectPrompt, runPlanModel } from "./plan-service.js";
import { loadContinuity } from "./continuity-service.js";
import { resolveOutputMime } from "./media-mime.js";
import { compressPrompt } from "./prompt-compressor.js";
import { promptLimitFor } from "./prompt-limit.js";
import { assertDailyGenerationQuota } from "./quota-service.js";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { queueMail } from "./mail-service.js";
import { getLimitsSettings, getMailSettings, getPricing } from "./settings.js";
import { putAsset, urlForAsset } from "./storage-service.js";
import { commitHold, consumePlanQuota, holdTokens, refundHold } from "./token-service.js";

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
  /** Completed scenes whose prompt/visual notes feed the plan prompt. */
  chainSceneIds: string[];
}

export interface PlanGenerationResult {
  blueprint: { prompt: string; direction: string; negativePrompt: string };
  cost: { tokens: number; usesFreeQuota: boolean };
  workspace: WorkspaceDto;
  analysis: { attachments: { key: string; text: string }[]; preContext: string };
  /** Final-prompt ceiling the generate step will apply, so the canvas can warn before it runs. */
  limit: { promptChars: number };
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
  /** Completed scenes whose notes are injected and whose newest clip becomes the reference. */
  chainSceneIds: string[];
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

/** A generation row only ever describes a render, so TEXT catalog models are rejected here. */
type RenderableModelRow = AiModelRow & { mediaType: "VIDEO" | "IMAGE" };

async function loadModel(modelId: string): Promise<RenderableModelRow> {
  const [model] = await db.select().from(aiModels).where(eq(aiModels.id, modelId)).limit(1);
  if (!model) throw notFound("Model tidak ditemukan.");
  if (!model.isActive) throw conflict("Model ini sedang tidak aktif.");
  if (model.mediaType === "TEXT") throw validation("Model ini bukan model render.");
  return { ...model, mediaType: model.mediaType };
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

async function loadAssetByKey(key: string): Promise<MediaAssetRow | null> {
  const [asset] = await db.select().from(mediaAssets).where(eq(mediaAssets.key, key)).limit(1);
  if (!asset || asset.purgedAt) return null;
  return asset;
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

/**
 * Direct mode now runs the same plan model plan mode uses (without the review step, without
 * consuming plan quota). If the configured model fails, the deterministic blueprint keeps the
 * render alive instead of failing the request.
 */
async function composeDirectPrompt(input: {
  workspaceId: string;
  userId: string;
  folderId: string;
  model: RenderableModelRow;
  rawPrompt: string;
  selectedParams: GenerationParams;
  attachments: PlanAttachment[];
  attachmentTexts: string[];
  continuityText: string;
  hasReference: boolean;
  promptLimit: number;
}): Promise<string> {
  try {
    const plan = await runPlanModel({
      workspaceId: input.workspaceId,
      folderId: input.folderId,
      renderModel: input.model,
      rawPrompt: input.rawPrompt,
      attachmentTexts: input.attachmentTexts,
      attachments: input.attachments,
      contextText: input.continuityText,
      selectedParams: input.selectedParams,
      hasReference: input.hasReference,
      promptLimit: input.promptLimit,
      mode: "direct",
      userId: input.userId,
    });
    // `usedModelId` is empty only for the deterministic blueprint fallback, which omits the
    // attachment notes and the style lock that this composer adds itself.
    const prompt = plan.prompt.trim();
    if (plan.usedModelId.length > 0 && prompt.length > 0) return prompt;
  } catch (error) {
    logger.warn(
      { err: error, folderId: input.folderId },
      "direct-mode plan model failed; using the deterministic blueprint",
    );
  }

  return buildDirectPrompt({
    rawPrompt: input.rawPrompt,
    model: input.model,
    durationSec: input.selectedParams.durationSec,
    resolution: input.selectedParams.resolution,
    aspectRatio: input.selectedParams.aspectRatio,
    hasReference: input.hasReference,
    attachmentTexts: input.attachmentTexts,
    continuityText: input.continuityText,
  });
}

/**
 * Marks the render as started without resetting a start time a provider retry already recorded, so
 * the studio's elapsed timer stays truthful across queue retries.
 */
export async function markGenerationStarted(generationId: string): Promise<void> {
  await db
    .update(generations)
    .set({ status: "RENDERING", startedAt: sql`coalesce(${generations.startedAt}, now())` })
    .where(eq(generations.id, generationId));
}

/**
 * Persists a provider-reported status only when it differs, so polling does not rewrite rows.
 * Returns whether a row actually changed, which is what the worker logs.
 */
export async function markProviderStatus(
  generationId: string,
  providerStatus: string,
): Promise<boolean> {
  const updated = await db
    .update(generations)
    .set({ providerStatus })
    .where(
      and(
        eq(generations.id, generationId),
        sql`${generations.providerStatus} is distinct from ${providerStatus}`,
      ),
    )
    .returning({ id: generations.id });
  return updated.length > 0;
}

export async function planGeneration(input: PlanGenerationInput): Promise<PlanGenerationResult> {
  const limits = await getLimitsSettings(db);
  if (input.chainSceneIds.length > limits.maxSceneChainScenes) {
    throw validation(`Pilih maksimal ${limits.maxSceneChainScenes} scene untuk chain.`);
  }
  if (input.rawPrompt.trim().length === 0 || input.rawPrompt.length > limits.planPromptMaxChars) {
    throw validation(`Brief maksimal ${limits.planPromptMaxChars} karakter dan tidak boleh kosong.`);
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
  const continuity = await loadContinuity(db, {
    folderId: folder.id,
    contextIds: input.contextIds ?? [],
    chainSceneIds: input.chainSceneIds,
  });
  const promptLimit = promptLimitFor(model, limits);

  const plan = await runPlanModel({
    workspaceId: input.workspaceId,
    folderId: folder.id,
    renderModel: model,
    rawPrompt: input.rawPrompt,
    attachmentTexts: analyses.map((entry) => entry.analysis.text),
    attachments: planAttachmentsOf(resolved),
    contextText: continuity.text,
    selectedParams: {
      durationSec: input.durationSec,
      resolution: input.resolution,
      aspectRatio: input.aspectRatio,
    },
    hasReference: resolved.length > 0,
    promptLimit,
    mode: "plan",
    userId: input.userId,
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
      preContext: continuity.text,
    },
    limit: { promptChars: promptLimit },
  };
}

export async function createGeneration(input: CreateGenerationInput): Promise<CreateGenerationResult> {
  const limits = await getLimitsSettings(db);
  if (input.chainSceneIds.length > limits.maxSceneChainScenes) {
    throw validation(`Pilih maksimal ${limits.maxSceneChainScenes} scene untuk chain.`);
  }
  if (input.rawPrompt.trim().length === 0 || input.rawPrompt.length > limits.planPromptMaxChars) {
    throw validation(`Brief maksimal ${limits.planPromptMaxChars} karakter dan tidak boleh kosong.`);
  }

  const folder = await loadFolder(input.workspaceId, input.folderId);
  const model = await loadModel(input.modelId);
  assertParamsAllowed(model, input.selectedParams);
  await assertDailyGenerationQuota(input.workspaceId);

  const resolved = await loadAttachments(input.workspaceId, input.userId, input.attachmentKeys);
  // Plan mode only needs attachment analyses when a plan model can read them; direct mode always
  // needs them because they are what the server composes from.
  const analyzed =
    resolved.length > 0 &&
    (input.planMode ? await planModelForAttachments(planAttachmentsOf(resolved)) : true);

  const analyses = analyzed
    ? await Promise.all(
        resolved.map(async (item) => ({
          asset: item.asset,
          text: (await analyzeAsset(input.workspaceId, { mediaAssetId: item.asset.id })).text,
        })),
      )
    : [];

  const continuity = await loadContinuity(db, {
    folderId: folder.id,
    contextIds: input.contextIds,
    chainSceneIds: input.chainSceneIds,
  });
  const promptLimit = promptLimitFor(model, limits);
  const attachmentTexts = analyses.map((entry) => entry.text);

  let finalPrompt: string;
  if (input.planMode) {
    finalPrompt = input.finalPrompt?.trim() ?? "";
    if (finalPrompt.length === 0) throw validation("Buat plan terlebih dahulu.");
  } else {
    finalPrompt = (
      await composeDirectPrompt({
        workspaceId: input.workspaceId,
        userId: input.userId,
        folderId: folder.id,
        model,
        rawPrompt: input.rawPrompt,
        selectedParams: input.selectedParams,
        attachments: planAttachmentsOf(resolved),
        attachmentTexts,
        continuityText: continuity.text,
        hasReference: resolved.length > 0,
        promptLimit,
      })
    ).trim();
  }

  const limited = await compressPrompt({
    prompt: finalPrompt,
    limit: promptLimit,
    workspaceId: input.workspaceId,
  });
  finalPrompt = limited.prompt;
  if (finalPrompt.length === 0) throw validation("Prompt final tidak boleh kosong.");

  const firstAttachment = resolved[0] ?? null;
  // Continuity only ever adds a reference the workflow declares it accepts, and never overrides a
  // media file the user attached.
  const continuityAsset =
    !firstAttachment &&
    continuity.previous?.outputKey &&
    modelSupportsImageReference(model)
      ? await loadAssetByKey(continuity.previous.outputKey)
      : null;
  const referenceKey = firstAttachment?.asset.key ?? continuityAsset?.key ?? null;

  const analysisSnapshot = analyses
    .map((entry) => `# ${entry.asset.key}\n${entry.text}`)
    .join("\n\n");

  const created = await db.transaction(async (tx) => {
    const generationId = crypto.randomUUID();

    // One scene number per folder: the advisory lock serializes concurrent creates and the unique
    // (folder_id, sequence) index turns any leak into a hard error instead of a silent duplicate.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${folder.id})::bigint)`);
    const [sequenceRow] = await tx
      .select({ maxSequence: sql<number>`coalesce(max(${generations.sequence}), 0)` })
      .from(generations)
      .where(eq(generations.folderId, folder.id));
    const sequence = Number(sequenceRow?.maxSequence ?? 0) + 1;

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
        preContextSnapshot: continuity.text,
        referenceImageUrl: referenceKey,
        selectedParams: input.selectedParams,
        tokensCharged: model.tokenCost,
        status: "QUEUED",
        externalJobId: null,
        outputKey: null,
        sequence,
        continuitySourceId: continuityAsset ? continuity.previous?.id ?? null : null,
        errorMessage: null,
        refunded: false,
        promptCompressed: limited.compressed,
        promptLimitChars: promptLimit,
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

    if (continuityAsset) {
      await tx.insert(generationAttachments).values({
        generationId,
        role: "CONTINUITY" as const,
        mediaAssetId: continuityAsset.id,
        sourceGenerationId: continuity.previous?.id ?? null,
        analysisText: continuity.previous?.analysisSnapshot.slice(0, 2000) ?? "",
      });
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
  "image/gif": "gif",
  "image/avif": "avif",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
};

export function extensionForMime(mime: string): string {
  return MIME_EXTENSIONS[mime] ?? "bin";
}

/** Key layout: `workspaces/<id>/generations/<generationId>.<ext>` — immutable, capability-scoped. */
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

  // The provider's own content type is not reliable (`application/octet-stream` is common), and the
  // key extension drives both `<video>` playback and the media route's Content-Type.
  const mime = await resolveOutputMime(outcome.bytes, outcome.mime, generation.mediaType);
  const key = generationOutputKey(generation.workspaceId, generation.id, mime);
  await putAsset(generation.workspaceId, key, outcome.bytes, mime, {
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
        outputKey: key,
        outputMime: mime,
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

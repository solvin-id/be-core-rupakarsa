import { and, eq, like } from "drizzle-orm";

import type { ChatContentPart } from "../adapters/types.js";
import { db } from "../db/client.js";
import { assetAnalyses, generations, mediaAssets } from "../db/schema.js";
import type { MediaAssetRow } from "../db/schema.js";
import { notFound, validation } from "../http/errors.js";
import { getAnalysisAdapter } from "../providers/registry.js";
import { resolveStorage } from "./storage-service.js";

export type AnalysisSourceKind = "UPLOAD" | "GENERATION";

export interface AssetAnalysis {
  sourceKind: AnalysisSourceKind;
  sourceId: string;
  text: string;
  structured: Record<string, unknown>;
  modelId: string | null;
  cached: boolean;
}

export interface AnalyzeSource {
  mediaAssetId?: string;
  generationId?: string;
}

const ANALYSIS_PROMPT =
  "Analyse the attached media and return strict JSON {subject, camera, lighting, palette, motion, style, continuity, avoid} — each a short phrase, no prose.";

function stripFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced?.[1]?.trim() ?? trimmed;
}

export function parseStructured(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(stripFences(raw));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // A raw prose answer is still useful for the plan model; keep it as text only.
  }
  return {};
}

async function loadAsset(
  workspaceId: string,
  source: AnalyzeSource,
): Promise<{ asset: MediaAssetRow; sourceKind: AnalysisSourceKind; sourceId: string }> {
  if (source.generationId) {
    const [generation] = await db
      .select()
      .from(generations)
      .where(and(eq(generations.id, source.generationId), eq(generations.workspaceId, workspaceId)))
      .limit(1);
    if (!generation) throw notFound("Generation tidak ditemukan.");

    const [asset] = await db
      .select()
      .from(mediaAssets)
      .where(like(mediaAssets.key, `%${generation.id}.%`))
      .limit(1);
    if (!asset) throw validation("Hasil render ini belum tersedia untuk dianalisis.");

    return { asset, sourceKind: "GENERATION", sourceId: generation.id };
  }

  if (source.mediaAssetId) {
    const [asset] = await db
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.id, source.mediaAssetId))
      .limit(1);
    if (!asset) throw notFound("Lampiran tidak ditemukan.");
    if (asset.workspaceId && asset.workspaceId !== workspaceId) {
      throw notFound("Lampiran tidak ditemukan.");
    }
    return { asset, sourceKind: "UPLOAD", sourceId: asset.id };
  }

  throw validation("Kirim mediaAssetId atau generationId.");
}

export function analysisKindFor(mime: string): "image" | "video" {
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("image/")) return "image";
  throw validation("Hanya gambar atau video yang dapat dianalisis.");
}

export async function readAssetBytes(
  asset: MediaAssetRow,
): Promise<{ bytes: Buffer; mime: string } | null> {
  const storage = await resolveStorage(asset.workspaceId);
  const object = await storage.driver.read(asset.key, asset.externalId);
  if (!object) return null;
  return { bytes: object.bytes, mime: asset.mime || object.mime };
}

/**
 * One cached analysis row per asset. The model sees the media directly (multimodal content part);
 * a failed JSON parse keeps the raw text so the plan model can still use it.
 */
export async function analyzeAsset(
  workspaceId: string,
  source: AnalyzeSource,
  options: { refresh?: boolean } = {},
): Promise<AssetAnalysis> {
  const { asset, sourceKind, sourceId } = await loadAsset(workspaceId, source);

  if (!options.refresh) {
    const [existing] = await db
      .select()
      .from(assetAnalyses)
      .where(and(eq(assetAnalyses.sourceKind, sourceKind), eq(assetAnalyses.sourceId, sourceId)))
      .limit(1);
    if (existing) {
      return {
        sourceKind,
        sourceId,
        text: existing.text,
        structured: existing.structured,
        modelId: existing.modelId,
        cached: true,
      };
    }
  }

  const kind = analysisKindFor(asset.mime);
  const { adapter, model } = await getAnalysisAdapter(kind);

  const loaded = await readAssetBytes(asset);
  if (!loaded) throw validation("Berkas lampiran tidak dapat dibaca dari storage.");

  const dataUrl = `data:${loaded.mime};base64,${loaded.bytes.toString("base64")}`;
  const part: ChatContentPart =
    kind === "video"
      ? { type: "video_url", video_url: { url: dataUrl } }
      : { type: "image_url", image_url: { url: dataUrl } };

  const result = await adapter.chat({
    model: model.providerModelId || model.code,
    messages: [
      { role: "system", content: ANALYSIS_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: `File: ${asset.key.split("/").pop() ?? asset.key} (${loaded.mime}).` },
          part,
        ],
      },
    ],
    json: true,
  });

  const structured = parseStructured(result.text);
  const [saved] = await db
    .insert(assetAnalyses)
    .values({
      workspaceId,
      sourceKind,
      sourceId,
      modelId: model.id,
      inputKinds: [kind.toUpperCase()],
      text: result.text,
      structured,
    })
    .onConflictDoUpdate({
      target: [assetAnalyses.sourceKind, assetAnalyses.sourceId],
      set: {
        text: result.text,
        structured,
        modelId: model.id,
        inputKinds: [kind.toUpperCase()],
      },
    })
    .returning();

  return {
    sourceKind,
    sourceId,
    text: saved?.text ?? result.text,
    structured: saved?.structured ?? structured,
    modelId: model.id,
    cached: false,
  };
}

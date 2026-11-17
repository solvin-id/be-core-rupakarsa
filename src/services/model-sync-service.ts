import { eq } from "drizzle-orm";

import { decryptSecret } from "../crypto/encryption.js";
import type { DbHandle } from "../db/client.js";
import { aiModels, aiProviders } from "../db/schema.js";
import type {
  AiModelRow,
  AiProviderRow,
  ModelAllowedParams,
  ModelCapability,
} from "../db/schema.js";
import { env } from "../env.js";
import { AppError, notFound } from "../http/errors.js";
import { templatesForProvider } from "./model-catalog.js";
import { describeProviderFailure } from "./provider-failure.js";

const SYNC_TIMEOUT_MS = 15_000;

export interface RemoteModel {
  providerModelId: string;
  displayName: string;
  inputCapabilities: ModelCapability[];
  outputCapabilities: ModelCapability[];
  mediaType: "VIDEO" | "IMAGE" | "TEXT";
  /** Publisher-declared render options; empty when the payload does not advertise them. */
  durations: number[];
  resolutions: string[];
}

export interface RemoteCatalog {
  models: RemoteModel[];
  /** Entries this catalog cannot store at all: audio-only models, and entries without an id. */
  skipped: number;
}

export interface SyncResult {
  added: number;
  updated: number;
  skipped: number;
  models: AiModelRow[];
}

const DEFAULT_ALLOWED_PARAMS: Record<"VIDEO" | "IMAGE" | "TEXT", ModelAllowedParams> = {
  VIDEO: { durations: [5], resolutions: ["auto"], aspectRatios: ["16:9", "9:16", "1:1"] },
  IMAGE: { resolutions: ["1k"], aspectRatios: ["1:1", "4:3", "16:9", "9:16"] },
  // Plan/analysis models have no render options; the empty pair is the shape CMS validation expects.
  TEXT: { resolutions: [], aspectRatios: [] },
};

/**
 * Publishers that advertise render options (kenari: video_durations / video_resolutions) must not be
 * driven with the generic defaults, or every render asks for a duration the model cannot produce.
 */
function allowedParamsFor(model: RemoteModel): ModelAllowedParams | null {
  const defaults = DEFAULT_ALLOWED_PARAMS[model.mediaType];
  if (model.durations.length === 0 && model.resolutions.length === 0) return null;
  return {
    durations: model.durations.length > 0 ? model.durations : (defaults.durations ?? []),
    resolutions: model.resolutions.length > 0 ? model.resolutions : defaults.resolutions,
    aspectRatios: defaults.aspectRatios,
  };
}

function normalizeCapability(value: unknown): ModelCapability | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim().toUpperCase();
  if (candidate === "TEXT" || candidate === "IMAGE" || candidate === "VIDEO") return candidate;
  return null;
}

function capabilitiesFrom(raw: unknown): ModelCapability[] {
  if (!Array.isArray(raw)) return [];
  const rows: ModelCapability[] = [];
  for (const item of raw) {
    const capability = normalizeCapability(item);
    if (capability && !rows.includes(capability)) rows.push(capability);
  }
  return rows;
}

export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}

/** Decrypted provider credential; the fixed Higgsfield provider falls back to its env pair. */
export function resolveProviderKey(provider: AiProviderRow): string {
  if (provider.apiKeyEncrypted.length > 0) return decryptSecret(provider.apiKeyEncrypted);
  if (provider.kind === "HIGGSFIELD" && env.HIGGSFIELD_KEY_ID.length > 0) {
    return `${env.HIGGSFIELD_KEY_ID}:${env.HIGGSFIELD_KEY_SECRET}`;
  }
  return "";
}

export function providerAuthHeaders(provider: AiProviderRow, apiKey: string): Record<string, string> {
  if (apiKey.length === 0) return {};
  if (provider.kind === "HIGGSFIELD") {
    const [keyId, ...rest] = apiKey.split(":");
    const secret = rest.join(":");
    if (keyId && secret) return { Authorization: `Key ${keyId}:${secret}` };
  }
  return { Authorization: `Bearer ${apiKey}` };
}

interface RawRemoteEntry {
  id?: unknown;
  name?: unknown;
  architecture?: { input_modalities?: unknown; output_modalities?: unknown };
  input_modalities?: unknown;
  output_modalities?: unknown;
  /** kenari (and OpenAI-compatible gateways) publish capabilities here. */
  modalities?: { input?: unknown; output?: unknown };
  video_durations?: unknown;
  video_resolutions?: unknown;
}

function positiveInts(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const values: number[] = [];
  for (const item of raw) {
    const value = typeof item === "number" ? item : Number(item);
    if (Number.isInteger(value) && value > 0 && !values.includes(value)) values.push(value);
  }
  return values;
}

function nonEmptyStrings(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const values: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const value = item.trim();
    if (value.length > 0 && !values.includes(value)) values.push(value);
  }
  return values;
}

/**
 * Chat-only entries are imported as TEXT so the CMS can pick them for plan/analysis;
 * audio-only entries stay unsupported and are counted as skipped.
 */
export function toRemoteModel(entry: RawRemoteEntry): RemoteModel | null {
  if (typeof entry.id !== "string" || entry.id.trim().length === 0) return null;
  const providerModelId = entry.id.trim();

  const inputs = capabilitiesFrom(
    entry.architecture?.input_modalities ?? entry.input_modalities ?? entry.modalities?.input,
  );
  const outputs = capabilitiesFrom(
    entry.architecture?.output_modalities ?? entry.output_modalities ?? entry.modalities?.output,
  );

  const mediaType: "VIDEO" | "IMAGE" | "TEXT" | null = outputs.includes("VIDEO")
    ? "VIDEO"
    : outputs.includes("IMAGE")
      ? "IMAGE"
      : outputs.includes("TEXT")
        ? "TEXT"
        : null;
  if (!mediaType) return null;

  return {
    providerModelId,
    displayName: typeof entry.name === "string" && entry.name.length > 0 ? entry.name : providerModelId,
    inputCapabilities: inputs.length > 0 ? inputs : ["TEXT"],
    outputCapabilities: outputs,
    mediaType,
    durations: positiveInts(entry.video_durations),
    resolutions: nonEmptyStrings(entry.video_resolutions),
  };
}

function templateCatalog(provider: AiProviderRow): RemoteCatalog {
  const models = templatesForProvider(provider.code).map<RemoteModel>((template) => ({
    providerModelId: template.code,
    displayName: template.displayName,
    inputCapabilities: ["TEXT", "IMAGE"],
    outputCapabilities: [template.mediaType],
    mediaType: template.mediaType,
    durations: template.allowedParams.durations ?? [],
    resolutions: template.allowedParams.resolutions ?? [],
  }));
  return { models, skipped: 0 };
}

export async function fetchRemoteCatalog(provider: AiProviderRow): Promise<RemoteCatalog> {
  if (provider.kind === "HIGGSFIELD") return templateCatalog(provider);

  const apiKey = resolveProviderKey(provider);
  const url = joinUrl(provider.baseUrl, provider.modelsPath);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json", ...providerAuthHeaders(provider, apiKey) },
      signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
    });
  } catch (error) {
    throw new AppError(502, "PROVIDER_UNREACHABLE", describeProviderFailure(error, url, SYNC_TIMEOUT_MS));
  }

  if (!response.ok) {
    throw new AppError(502, "PROVIDER_UNREACHABLE", `Provider membalas ${response.status}.`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AppError(502, "PROVIDER_UNREACHABLE", "Respons provider bukan JSON.");
  }

  const entries: RawRemoteEntry[] = Array.isArray(payload)
    ? (payload as RawRemoteEntry[])
    : Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: RawRemoteEntry[] }).data
      : [];

  const models: RemoteModel[] = [];
  let skipped = 0;
  for (const entry of entries) {
    const model = toRemoteModel(entry);
    if (model) models.push(model);
    else skipped += 1;
  }
  return { models, skipped };
}

/**
 * Upserts the provider catalog. Operator overrides — token cost, allowed params, active flag —
 * are never touched here; a sync only refreshes identity and capability metadata.
 */
export async function syncProviderModels(db: DbHandle, providerId: string): Promise<SyncResult> {
  const [provider] = await db.select().from(aiProviders).where(eq(aiProviders.id, providerId)).limit(1);
  if (!provider) throw notFound("Provider tidak ditemukan.");

  let catalog: RemoteCatalog;
  try {
    catalog = await fetchRemoteCatalog(provider);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sinkronisasi model gagal.";
    await db
      .update(aiProviders)
      .set({ syncError: message, updatedAt: new Date() })
      .where(eq(aiProviders.id, provider.id));
    if (error instanceof AppError) throw error;
    throw new AppError(502, "PROVIDER_UNREACHABLE", message);
  }

  const existingRows = await db.select().from(aiModels).where(eq(aiModels.providerId, provider.id));
  const existingCodes = new Set(existingRows.map((row) => row.code));

  let added = 0;
  let updated = 0;
  for (const model of catalog.models) {
    const template = templatesForProvider(provider.code).find(
      (entry) => entry.code === model.providerModelId,
    );

    await db
      .insert(aiModels)
      .values({
        providerId: provider.id,
        code: model.providerModelId,
        displayName: model.displayName,
        providerModelId: model.providerModelId,
        mediaType: model.mediaType,
        inputCapabilities: model.inputCapabilities,
        outputCapabilities: model.outputCapabilities,
        source: "SYNC",
        syncMetadata: {
          providerModelId: model.providerModelId,
          inputCapabilities: model.inputCapabilities,
          outputCapabilities: model.outputCapabilities,
        },
        allowedParams:
          template?.allowedParams ?? allowedParamsFor(model) ?? DEFAULT_ALLOWED_PARAMS[model.mediaType],
        tokenCost: template?.tokenCost ?? 0,
        isActive: true,
      })
      .onConflictDoUpdate({
        target: [aiModels.providerId, aiModels.code],
        set: {
          displayName: model.displayName,
          providerModelId: model.providerModelId,
          mediaType: model.mediaType,
          inputCapabilities: model.inputCapabilities,
          outputCapabilities: model.outputCapabilities,
          source: "SYNC",
        },
      });

    if (existingCodes.has(model.providerModelId)) updated += 1;
    else added += 1;
  }

  await db
    .update(aiProviders)
    .set({ lastSyncedAt: new Date(), syncError: null, updatedAt: new Date() })
    .where(eq(aiProviders.id, provider.id));

  const models = await db
    .select()
    .from(aiModels)
    .where(eq(aiModels.providerId, provider.id))
    .orderBy(aiModels.displayName);

  return { added, updated, skipped: catalog.skipped, models };
}

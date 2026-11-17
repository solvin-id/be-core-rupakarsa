import { AppError } from "../http/errors.js";
import type { AiModelRow, AiProviderRow } from "../db/schema.js";
import { joinUrl, providerAuthHeaders, resolveProviderKey } from "../services/model-sync-service.js";
import type {
  RenderAdapter,
  RenderRequest,
  RenderResult,
  VideoJobStatus,
  VideoRenderAdapter,
} from "./types.js";

/**
 * The current Higgsfield API is one path per workflow: `POST /<endpoint-id>` answers
 * `{ status, request_id, status_url }`, the status URL reports `video.url` once completed, and the
 * clip downloads from that URL. `ai_models.provider_model_id` holds the endpoint id.
 */
export const HIGGSFIELD_CONTRACT = {
  /** Endpoint ids are paths, so the model id is appended to the base URL. */
  submitPath: (endpointId: string) => `/${endpointId.replace(/^\/+/, "")}`,
  statusPath: (jobId: string) => `/requests/${jobId}/status`,
  pending: new Set(["queued", "in_progress", "processing", "pending"]),
  done: new Set(["completed", "succeeded", "done"]),
  failed: new Set(["failed", "cancelled", "canceled", "nsfw", "expired"]),
  /** Request fields a workflow accepts; anything else is rejected with a 400 per model. */
  defaultFields: ["duration", "resolution", "aspectRatio"],
} as const;

type RequestField = "duration" | "resolution" | "aspectRatio";

interface StatusPayload {
  status?: unknown;
  video?: { url?: unknown };
  image?: { url?: unknown };
  detail?: unknown;
  error?: unknown;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function requestFieldsOf(model: AiModelRow): RequestField[] {
  const raw = (model.syncMetadata as { requestFields?: unknown }).requestFields;
  if (!Array.isArray(raw)) return [...HIGGSFIELD_CONTRACT.defaultFields];
  const fields = raw.filter(
    (field): field is RequestField =>
      field === "duration" || field === "resolution" || field === "aspectRatio",
  );
  return fields.length > 0 ? fields : [...HIGGSFIELD_CONTRACT.defaultFields];
}

export class HiggsfieldRenderAdapter implements RenderAdapter, VideoRenderAdapter {
  private readonly provider: AiProviderRow;
  private readonly model: AiModelRow;

  constructor(provider: AiProviderRow, model: AiModelRow) {
    this.provider = provider;
    this.model = model;
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...providerAuthHeaders(this.provider, resolveProviderKey(this.provider)),
    };
  }

  private endpointId(): string {
    return this.model.providerModelId || this.model.code;
  }

  async submitVideo(input: RenderRequest, signal: AbortSignal): Promise<{ jobId: string }> {
    const fields = requestFieldsOf(this.model);
    const body = {
      prompt: input.prompt,
      ...(fields.includes("duration") && input.selectedParams.durationSec !== undefined
        ? { duration: input.selectedParams.durationSec }
        : {}),
      ...(fields.includes("resolution") && input.selectedParams.resolution !== "auto"
        ? { resolution: input.selectedParams.resolution }
        : {}),
      ...(fields.includes("aspectRatio") && input.selectedParams.aspectRatio
        ? { aspect_ratio: input.selectedParams.aspectRatio }
        : {}),
      ...(input.referenceUrl ? { image_url: input.referenceUrl } : {}),
    };

    const url = joinUrl(this.provider.baseUrl, HIGGSFIELD_CONTRACT.submitPath(this.endpointId()));
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      throw new AppError(502, "PROVIDER_ERROR", describeFailure(error, url));
    }

    if (!response.ok) {
      throw providerError(response, await response.text());
    }

    const payload = (await response.json().catch(() => ({}))) as {
      request_id?: unknown;
      status?: unknown;
    };
    const jobId = readString(payload.request_id);
    if (!jobId) throw new AppError(502, "PROVIDER_ERROR", "Provider tidak mengembalikan id job.");
    return { jobId };
  }

  async pollVideo(jobId: string, signal: AbortSignal): Promise<VideoJobStatus> {
    const url = joinUrl(this.provider.baseUrl, HIGGSFIELD_CONTRACT.statusPath(jobId));
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: this.headers(),
        signal,
      });
    } catch (error) {
      throw new AppError(502, "PROVIDER_ERROR", describeFailure(error, url));
    }

    if (response.status === 429 || response.status === 503) return { state: "pending" };
    if (!response.ok) throw providerError(response, await response.text());

    const payload = (await response.json().catch(() => ({}))) as StatusPayload;
    const status = readString(payload.status)?.toLowerCase() ?? "";

    if (HIGGSFIELD_CONTRACT.done.has(status)) {
      const outputUrl = readString(payload.video?.url) ?? readString(payload.image?.url);
      if (!outputUrl) throw new AppError(502, "PROVIDER_ERROR", "Provider tidak mengembalikan hasil render.");
      return { state: "done", url: outputUrl };
    }
    if (HIGGSFIELD_CONTRACT.failed.has(status)) {
      return {
        state: "failed",
        reason: readString(payload.detail) ?? readString(payload.error) ?? "Provider gagal merender.",
      };
    }
    return { state: "pending" };
  }

  async downloadVideo(url: string, signal: AbortSignal): Promise<{ bytes: Buffer; mime: string }> {
    let response: Response;
    try {
      response = await fetch(url, { method: "GET", headers: this.headers(), signal });
    } catch (error) {
      throw new AppError(502, "PROVIDER_ERROR", describeFailure(error, url));
    }

    if (!response.ok) {
      throw new AppError(502, "PROVIDER_ERROR", `Unduhan hasil render gagal (${response.status}).`);
    }

    const mime = (response.headers.get("content-type") ?? "video/mp4").split(";")[0]?.trim();
    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      mime: mime && mime.length > 0 ? mime : "video/mp4",
    };
  }

  /** Every shipped Higgsfield workflow is an asynchronous job; the worker routes video here. */
  async render(_input: RenderRequest, _signal: AbortSignal): Promise<RenderResult> {
    throw new AppError(
      400,
      "UNSUPPORTED_CAPABILITY",
      "Provider Higgsfield merender lewat alur job video, bukan render tunggal.",
    );
  }
}

function describeFailure(error: unknown, url: string): string {
  if (error instanceof Error && error.name === "AbortError") {
    return "Render melewati batas waktu.";
  }
  const host = new URL(url).host;
  return `Koneksi ke ${host} gagal.`;
}

function providerError(response: Response, detail: string): AppError {
  if (response.status === 401 || response.status === 403) {
    return new AppError(502, "PROVIDER_ERROR", `Provider menolak kredensial (${response.status}).`);
  }
  if (response.status === 402) {
    return new AppError(502, "PROVIDER_ERROR", "Saldo provider Higgsfield tidak cukup.");
  }
  // higgsfield answers errors as {"detail": "..."} and reports the real reason there.
  let message = "";
  try {
    const parsed = JSON.parse(detail) as { detail?: unknown };
    message = readString(parsed.detail) ?? "";
  } catch {
    message = detail.trim();
  }
  return new AppError(
    502,
    "PROVIDER_ERROR",
    `Provider membalas ${response.status}: ${(message || "tanpa keterangan").slice(0, 300)}`,
  );
}

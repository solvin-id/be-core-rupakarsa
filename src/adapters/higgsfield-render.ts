import { AppError } from "../http/errors.js";
import type { AiModelRow, AiProviderRow } from "../db/schema.js";
import { joinUrl, providerAuthHeaders, resolveProviderKey } from "../services/model-sync-service.js";
import type { RenderAdapter, RenderRequest, RenderResult } from "./types.js";
import { waitFor } from "./wait-for.js";

const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 120_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;

/**
 * Every provider-specific path and field lives here. When the real Higgsfield contract differs,
 * only this object changes; the download + finalize flow stays identical.
 */
export const HIGGSFIELD_CONTRACT = {
  submitPath: "/v1/generations",
  statusPath: (jobId: string) => `/v1/generations/${jobId}`,
  statusField: "status",
  outputField: "output",
  outputUrlField: "url",
  errorField: "error",
  completed: new Set(["completed", "succeeded"]),
  failed: new Set(["failed", "cancelled", "canceled"]),
} as const;

interface StatusPayload {
  status?: unknown;
  output?: Array<{ url?: unknown }>;
  error?: unknown;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export class HiggsfieldRenderAdapter implements RenderAdapter {
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

  async render(input: RenderRequest, signal: AbortSignal): Promise<RenderResult> {
    const jobId = await this.submit(input, signal);
    const outputUrl = await this.poll(jobId, signal);

    let response: Response;
    try {
      response = await fetch(outputUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    } catch {
      throw new AppError(502, "PROVIDER_ERROR", "Hasil render tidak dapat diunduh.");
    }
    if (!response.ok) {
      throw new AppError(502, "PROVIDER_ERROR", `Unduhan hasil render gagal (${response.status}).`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    const mime = response.headers.get("content-type")?.split(";")[0]?.trim() || "video/mp4";

    return {
      bytes,
      mime,
      externalJobId: jobId,
      durationSec: input.selectedParams.durationSec,
    };
  }

  private async submit(input: RenderRequest, signal: AbortSignal): Promise<string> {
    let response: Response;
    try {
      response = await fetch(joinUrl(this.provider.baseUrl, HIGGSFIELD_CONTRACT.submitPath), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          model: this.model.providerModelId || this.model.code,
          prompt: input.prompt,
          duration: input.selectedParams.durationSec,
          resolution: input.selectedParams.resolution,
          aspect_ratio: input.selectedParams.aspectRatio,
          ...(input.referenceUrl ? { image_url: input.referenceUrl } : {}),
        }),
        signal,
      });
    } catch {
      throw new AppError(502, "PROVIDER_ERROR", "Provider tidak dapat dihubungi.");
    }

    if (!response.ok) {
      const detail = await response.text();
      throw new AppError(502, "PROVIDER_ERROR", `Provider membalas ${response.status}: ${detail.slice(0, 300)}`);
    }

    const payload = (await response.json()) as { id?: unknown; job_id?: unknown };
    const jobId = readString(payload.id) ?? readString(payload.job_id);
    if (!jobId) throw new AppError(502, "PROVIDER_ERROR", "Provider tidak mengembalikan id job.");
    return jobId;
  }

  private async poll(jobId: string, signal: AbortSignal): Promise<string> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    const url = joinUrl(this.provider.baseUrl, HIGGSFIELD_CONTRACT.statusPath(jobId));

    while (Date.now() < deadline) {
      await waitFor(POLL_INTERVAL_MS, signal);

      let response: Response;
      try {
        response = await fetch(url, { headers: this.headers(), signal });
      } catch {
        throw new AppError(502, "PROVIDER_ERROR", "Status render tidak dapat dibaca.");
      }
      if (!response.ok) {
        throw new AppError(502, "PROVIDER_ERROR", `Provider membalas ${response.status}.`);
      }

      const payload = (await response.json()) as StatusPayload;
      const status = readString(payload.status)?.toLowerCase() ?? "";

      if (HIGGSFIELD_CONTRACT.failed.has(status)) {
        throw new AppError(502, "PROVIDER_ERROR", readString(payload.error) ?? "Provider gagal merender.");
      }
      if (HIGGSFIELD_CONTRACT.completed.has(status)) {
        const output = Array.isArray(payload.output) ? payload.output : [];
        const outputUrl = output
          .map((entry) => readString(entry?.url))
          .find((value): value is string => value !== null);
        if (!outputUrl) throw new AppError(502, "PROVIDER_ERROR", "Provider tidak mengembalikan hasil render.");
        return outputUrl;
      }
    }

    throw new AppError(504, "PROVIDER_TIMEOUT", "Render melewati batas waktu.");
  }
}

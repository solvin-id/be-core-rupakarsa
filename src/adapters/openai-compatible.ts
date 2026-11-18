import type { AiModelRow, AiProviderRow } from "../db/schema.js";
import { AppError } from "../http/errors.js";
import type {
  ChatMessage,
  ChatResult,
  RenderAdapter,
  RenderRequest,
  RenderResult,
  VideoJobStatus,
  VideoRenderAdapter,
} from "./types.js";
import { joinUrl, resolveProviderKey } from "../services/model-sync-service.js";
import { describeProviderFailure } from "../services/provider-failure.js";

const REQUEST_TIMEOUT_MS = 120_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const RETRY_DELAY_MS = 2_000;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * Every provider-specific path and field for async video jobs. Kenari publishes this shape;
 * a publisher using the plain OpenAI shape (`/videos`) fails with the provider's own message.
 */
export const OPENAI_VIDEO_CONTRACT = {
  submitPath: "/videos/generations",
  statusPath: (jobId: string) => `/videos/${jobId}`,
  pending: new Set(["rendering", "queued", "in_progress"]),
  done: new Set(["done", "completed", "succeeded"]),
  failed: new Set(["failed", "expired", "cancelled", "canceled"]),
} as const;

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function authHeaders(provider: AiProviderRow): Record<string, string> {
  const apiKey = resolveProviderKey(provider);
  if (apiKey.length === 0) return {};
  return { Authorization: `Bearer ${apiKey}` };
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<Response> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal,
      });
      if (RETRYABLE_STATUS.has(response.status)) {
        lastError = new Error(`Provider membalas ${response.status}.`);
        continue;
      }
      return response;
    } catch (error) {
      if (signal.aborted) break;
      lastError = error;
    }
  }
  if (signal.aborted) throw new AppError(504, "PROVIDER_TIMEOUT", "Render melewati batas waktu.");
  throw new AppError(502, "PROVIDER_ERROR", describeProviderFailure(lastError, url, REQUEST_TIMEOUT_MS));
}

/** One adapter for every OpenAI-compatible publisher (DeepSeek, OpenRouter, vLLM, ...). */
export class OpenAiCompatibleAdapter implements RenderAdapter, VideoRenderAdapter {
  readonly supportsImageJobs = false;

  private readonly provider: AiProviderRow;
  private readonly model: AiModelRow | null;

  constructor(provider: AiProviderRow, model: AiModelRow | null = null) {
    this.provider = provider;
    this.model = model;
  }

  async chat(input: { model: string; messages: ChatMessage[]; json?: boolean }): Promise<ChatResult> {
    const url = joinUrl(this.provider.baseUrl, "/chat/completions");
    const response = await postJson(
      url,
      {
        model: input.model,
        messages: input.messages,
        ...(input.json ? { response_format: { type: "json_object" } } : {}),
      },
      authHeaders(this.provider),
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    );

    if (!response.ok) {
      const detail = await response.text();
      throw new AppError(502, "PROVIDER_ERROR", `Provider membalas ${response.status}: ${detail.slice(0, 300)}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
      usage?: { total_tokens?: unknown };
    };
    const content = payload.choices?.[0]?.message?.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : ""))
              .join("")
          : "";
    if (text.trim().length === 0) {
      throw new AppError(502, "PROVIDER_ERROR", "Provider mengembalikan jawaban kosong.");
    }

    const totalTokens =
      typeof payload.usage?.total_tokens === "number" ? payload.usage.total_tokens : 0;
    return { text, usage: { totalTokens } };
  }

  async image(input: { model: string; prompt: string; size: string }): Promise<{ bytes: Buffer; mime: string }> {
    const url = joinUrl(this.provider.baseUrl, "/images/generations");
    const response = await postJson(
      url,
      { model: input.model, prompt: input.prompt, size: input.size, n: 1, response_format: "b64_json" },
      authHeaders(this.provider),
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    );

    if (!response.ok) {
      const detail = await response.text();
      throw new AppError(502, "PROVIDER_ERROR", `Provider membalas ${response.status}: ${detail.slice(0, 300)}`);
    }

    const payload = (await response.json()) as {
      data?: Array<{ b64_json?: unknown; url?: unknown }>;
    };
    const first = payload.data?.[0];
    if (first && typeof first.b64_json === "string") {
      return { bytes: Buffer.from(first.b64_json, "base64"), mime: "image/png" };
    }
    if (first && typeof first.url === "string") {
      const downloaded = await fetch(first.url, { signal: AbortSignal.timeout(60_000) });
      if (!downloaded.ok) {
        throw new AppError(502, "PROVIDER_ERROR", "Gambar hasil render tidak dapat diunduh.");
      }
      return {
        bytes: Buffer.from(await downloaded.arrayBuffer()),
        mime: downloaded.headers.get("content-type") ?? "image/png",
      };
    }
    throw new AppError(502, "PROVIDER_ERROR", "Provider tidak mengembalikan gambar.");
  }

  async submitVideo(input: RenderRequest, signal: AbortSignal): Promise<{ jobId: string }> {
    const model = this.model;
    if (!model) {
      throw new AppError(500, "INTERNAL", "Model render tidak terikat ke adapter.");
    }

    const url = joinUrl(this.provider.baseUrl, OPENAI_VIDEO_CONTRACT.submitPath);
    const body = {
      model: model.providerModelId || model.code,
      prompt: input.prompt,
      ...(input.selectedParams.durationSec !== undefined
        ? { duration: input.selectedParams.durationSec }
        : {}),
      ...(input.selectedParams.resolution !== "auto"
        ? { resolution: input.selectedParams.resolution }
        : {}),
      ...(input.selectedParams.aspectRatio ? { aspect_ratio: input.selectedParams.aspectRatio } : {}),
      ...(input.referenceImages[0] ? { image_url: input.referenceImages[0] } : {}),
    };

    // Deliberately no retry loop: an accepted submit is a billed job, so a lost response must not
    // be replayed the way `postJson` replays chat/image requests.
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(this.provider) },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      throw new AppError(502, "PROVIDER_ERROR", describeProviderFailure(error, url, REQUEST_TIMEOUT_MS));
    }

    if (!response.ok) {
      const detail = await response.text();
      throw new AppError(502, "PROVIDER_ERROR", `Provider membalas ${response.status}: ${detail.slice(0, 300)}`);
    }

    const payload = (await response.json().catch(() => ({}))) as { id?: unknown };
    const jobId = readString(payload.id);
    if (!jobId) throw new AppError(502, "PROVIDER_ERROR", "Provider tidak mengembalikan id job.");
    return { jobId };
  }

  async pollVideo(jobId: string, signal: AbortSignal): Promise<VideoJobStatus> {
    const url = joinUrl(this.provider.baseUrl, OPENAI_VIDEO_CONTRACT.statusPath(jobId));

    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json", ...authHeaders(this.provider) },
        signal,
      });
    } catch (error) {
      throw new AppError(502, "PROVIDER_ERROR", describeProviderFailure(error, url, REQUEST_TIMEOUT_MS));
    }

    // Transient provider-side pressure: keep the job alive and let the worker poll again.
    if (response.status === 429 || response.status === 503) {
      return { state: "pending", providerStatus: "retrying" };
    }
    if (!response.ok) {
      throw new AppError(502, "PROVIDER_ERROR", `Provider membalas ${response.status}.`);
    }

    const payload = (await response.json().catch(() => ({}))) as {
      status?: unknown;
      url?: unknown;
      failure_reason?: unknown;
    };
    const status = readString(payload.status)?.toLowerCase() ?? "";

    if (OPENAI_VIDEO_CONTRACT.done.has(status)) {
      const outputUrl = readString(payload.url);
      if (!outputUrl) throw new AppError(502, "PROVIDER_ERROR", "Provider tidak mengembalikan hasil render.");
      return { state: "done", url: outputUrl };
    }
    if (OPENAI_VIDEO_CONTRACT.failed.has(status)) {
      return { state: "failed", reason: readString(payload.failure_reason) ?? "Provider gagal merender." };
    }
    return { state: "pending", providerStatus: status.length > 0 ? status : undefined };
  }

  async downloadVideo(url: string, signal: AbortSignal): Promise<{ bytes: Buffer; mime: string }> {
    let response: Response;
    try {
      response = await fetch(url, { method: "GET", headers: authHeaders(this.provider), signal });
    } catch (error) {
      throw new AppError(502, "PROVIDER_ERROR", describeProviderFailure(error, url, DOWNLOAD_TIMEOUT_MS));
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

  async render(input: RenderRequest, signal: AbortSignal): Promise<RenderResult> {
    if (input.mediaType === "VIDEO") {
      throw new AppError(
        400,
        "UNSUPPORTED_CAPABILITY",
        "Provider OpenAI-compatible belum mendukung output video.",
      );
    }

    const model = this.model;
    if (!model) {
      throw new AppError(500, "INTERNAL", "Model render tidak terikat ke adapter.");
    }
    const { bytes, mime } = await this.image({
      model: model.providerModelId || model.code,
      prompt: input.prompt,
      size: input.selectedParams.resolution,
    });
    void signal;

    return {
      bytes,
      mime,
      externalJobId: `oai_${crypto.randomUUID()}`,
    };
  }
}

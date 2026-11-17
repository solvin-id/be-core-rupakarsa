import type { AiModelRow, GenerationParams } from "../db/schema.js";

export interface PlanRequest {
  rawPrompt: string;
  model: AiModelRow;
  durationSec?: number;
  resolution: string;
  aspectRatio: string;
  hasReference: boolean;
}

export interface PlanResult {
  prompt: string;
  direction: string;
  negativePrompt: string;
}

export interface RenderRequest {
  generationId: string;
  prompt: string;
  mediaType: "VIDEO" | "IMAGE";
  modelName: string;
  selectedParams: GenerationParams;
  simulateFailure: boolean;
  referenceUrl?: string | null;
}

export interface RenderResult {
  /** Encoded media bytes; the worker persists them through the workspace-aware storage service. */
  bytes: Buffer;
  mime: string;
  externalJobId: string;
  width?: number;
  height?: number;
  durationSec?: number;
}

export interface StoredObject {
  bytes: Buffer;
  mime: string;
}

export interface StoredObjectMeta {
  size: number;
  mime: string;
}

export interface ByteRange {
  /** Inclusive first byte. */
  start: number;
  /** Inclusive last byte, already clamped to `size - 1`. */
  end: number;
}

export interface StoredRange {
  bytes: Buffer;
  mime: string;
  size: number;
}

export interface PutResult {
  /** Provider-side identifier (S3 ETag, Drive file id). */
  externalId?: string;
}

export interface StorageDriver {
  put(key: string, bytes: Buffer, mime: string): Promise<PutResult>;
  url(key: string): string;
  read(key: string, externalId?: string | null): Promise<StoredObject | null>;
  remove(key: string, externalId?: string | null): Promise<void>;
  /** Optional: size + mime without transferring the body, which enables `Range` playback. */
  stat?(key: string, externalId?: string | null): Promise<StoredObjectMeta | null>;
  /** Optional: one byte range of the object; absent drivers fall back to a full read. */
  readRange?(
    key: string,
    range: ByteRange,
    externalId?: string | null,
  ): Promise<StoredRange | null>;
}

export interface PlanAdapter {
  plan(input: PlanRequest): Promise<PlanResult>;
}

export interface RenderAdapter {
  render(input: RenderRequest, signal: AbortSignal): Promise<RenderResult>;
}

export type VideoJobStatus =
  | { state: "pending"; providerStatus?: string }
  | { state: "done"; url: string }
  | { state: "failed"; reason: string };

/** Optional capability: a provider whose video jobs are asynchronous submit/poll/download. */
export interface VideoRenderAdapter {
  submitVideo(input: RenderRequest, signal: AbortSignal): Promise<{ jobId: string }>;
  pollVideo(jobId: string, signal: AbortSignal): Promise<VideoJobStatus>;
  downloadVideo(url: string, signal: AbortSignal): Promise<{ bytes: Buffer; mime: string }>;
}

export function supportsVideoAdapter(
  adapter: RenderAdapter,
): adapter is RenderAdapter & VideoRenderAdapter {
  const candidate = adapter as Partial<VideoRenderAdapter>;
  return (
    typeof candidate.submitVideo === "function" &&
    typeof candidate.pollVideo === "function" &&
    typeof candidate.downloadVideo === "function"
  );
}

export interface ChatContentPart {
  type: "text" | "image_url" | "video_url";
  text?: string;
  image_url?: { url: string };
  video_url?: { url: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ChatContentPart[];
}

export interface ChatResult {
  text: string;
  usage: { totalTokens: number };
}

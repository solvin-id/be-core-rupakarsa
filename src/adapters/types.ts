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

export interface PutResult {
  /** Provider-side identifier (S3 ETag, Drive file id). */
  externalId?: string;
}

export interface StorageDriver {
  put(key: string, bytes: Buffer, mime: string): Promise<PutResult>;
  url(key: string): string;
  read(key: string, externalId?: string | null): Promise<StoredObject | null>;
  remove(key: string, externalId?: string | null): Promise<void>;
}

export interface PlanAdapter {
  plan(input: PlanRequest): Promise<PlanResult>;
}

export interface RenderAdapter {
  render(input: RenderRequest, signal: AbortSignal): Promise<RenderResult>;
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

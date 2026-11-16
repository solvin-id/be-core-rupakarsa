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
}

export interface RenderResult {
  outputKey: string;
  externalJobId: string;
}

export interface StoredObject {
  bytes: Buffer;
  mime: string;
}

export interface StorageDriver {
  put(key: string, bytes: Buffer, mime: string): Promise<void>;
  url(key: string): string;
  read(key: string): Promise<StoredObject | null>;
}

export interface PlanAdapter {
  plan(input: PlanRequest): Promise<PlanResult>;
}

export interface RenderAdapter {
  render(input: RenderRequest, signal: AbortSignal): Promise<RenderResult>;
}

export interface ProviderRegistry {
  plan: PlanAdapter;
  render: RenderAdapter;
}

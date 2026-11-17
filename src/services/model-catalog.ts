import type { ModelAllowedParams } from "../db/schema.js";

/** Request fields a workflow actually accepts; higgsfield rejects any field it does not declare. */
export type ModelRequestField = "duration" | "resolution" | "aspectRatio";

export interface ModelTemplate {
  providerCode: string;
  code: string;
  displayName: string;
  mediaType: "VIDEO" | "IMAGE";
  allowedParams: ModelAllowedParams;
  tokenCost: number;
  /** Provider-side id when it differs from `code` (higgsfield: the workflow endpoint id). */
  providerModelId?: string;
  /** Fields sent to the provider; omitted means every render option the row carries. */
  requestFields?: ModelRequestField[];
}

/**
 * Higgsfield codes stay stable for the catalog and existing rows; `providerModelId` carries the
 * workflow endpoint id (`POST /<id>`) from https://docs.higgsfield.ai/docs/models.
 */
export const MODEL_TEMPLATES: ModelTemplate[] = [
  {
    providerCode: "HIGGSFIELD",
    code: "wan-qwen-10s",
    displayName: "Wan 3.0 10s",
    mediaType: "VIDEO",
    allowedParams: {
      durations: [10],
      resolutions: ["480p", "720p", "1080p"],
      aspectRatios: ["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16"],
    },
    tokenCost: 35,
    providerModelId: "alibaba/wan-3.0/text-to-video",
  },
  {
    providerCode: "HIGGSFIELD",
    code: "wan-qwen-5s",
    displayName: "Wan 3.0 5s",
    mediaType: "VIDEO",
    allowedParams: {
      durations: [5],
      resolutions: ["480p", "720p", "1080p"],
      aspectRatios: ["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16"],
    },
    tokenCost: 18,
    providerModelId: "alibaba/wan-3.0/text-to-video",
  },
  {
    providerCode: "HIGGSFIELD",
    code: "kling-2.6-pro",
    displayName: "Kling 2.6 Pro",
    mediaType: "VIDEO",
    // The workflow exposes no resolution field; the row keeps a display-only default.
    allowedParams: {
      durations: [5, 10],
      resolutions: ["auto"],
      aspectRatios: ["16:9", "9:16", "1:1"],
    },
    tokenCost: 42,
    providerModelId: "kling-video/v2.6/pro/text-to-video",
    requestFields: ["duration", "aspectRatio"],
  },
  {
    providerCode: "HIGGSFIELD",
    code: "kling-2.5-turbo-standard",
    displayName: "Kling 2.5 Turbo",
    mediaType: "VIDEO",
    allowedParams: {
      durations: [5, 10],
      resolutions: ["auto"],
      aspectRatios: ["16:9", "9:16", "1:1"],
    },
    tokenCost: 30,
    providerModelId: "kling-video/v2.5-turbo/pro/text-to-video",
    requestFields: ["duration", "aspectRatio"],
  },
  {
    providerCode: "HIGGSFIELD",
    code: "minimax-hailuo-2.3",
    displayName: "MiniMax Hailuo 2.3",
    mediaType: "VIDEO",
    // Duration-only workflow; resolution and aspect ratio stay display defaults.
    allowedParams: {
      durations: [6, 10],
      resolutions: ["720p"],
      aspectRatios: ["16:9"],
    },
    tokenCost: 25,
    providerModelId: "minimax/hailuo-2.3/standard/text-to-video",
    requestFields: ["duration"],
  },
  {
    providerCode: "HIGGSFIELD",
    code: "minimax-h3",
    displayName: "MiniMax H3",
    mediaType: "VIDEO",
    allowedParams: {
      durations: [5, 10, 15],
      resolutions: ["2K"],
      aspectRatios: ["auto", "adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
    },
    tokenCost: 40,
    providerModelId: "minimax/h3/text-to-video",
  },
  {
    providerCode: "HIGGSFIELD",
    code: "wan-3.0-prime",
    displayName: "Wan 3.0 Prime",
    mediaType: "VIDEO",
    allowedParams: {
      durations: [5, 10, 15, 20, 25, 30],
      resolutions: ["480p", "720p", "1080p"],
      aspectRatios: ["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16"],
    },
    tokenCost: 30,
    providerModelId: "alibaba/wan-3.0-prime/text-to-video",
  },
  {
    providerCode: "HIGGSFIELD",
    code: "flux-image",
    displayName: "Qwen Image 3",
    mediaType: "IMAGE",
    allowedParams: {
      resolutions: ["1k", "2k"],
      aspectRatios: ["1:1", "4:5", "16:9", "9:16"],
    },
    tokenCost: 2,
    providerModelId: "alibaba/qwen-image-3/text-to-image",
  },
  {
    providerCode: "HIGGSFIELD",
    code: "marketing-studio-image",
    displayName: "Marketing Studio Image",
    mediaType: "IMAGE",
    allowedParams: {
      resolutions: ["1k", "2k", "4k"],
      aspectRatios: ["1:1", "4:5", "9:16", "16:9", "3:4", "2:3", "3:2", "4:3", "21:9"],
    },
    tokenCost: 2,
    providerModelId: "higgsfield/ads-studio/v1.0",
  },
];

export function templatesForProvider(providerCode: string): ModelTemplate[] {
  return MODEL_TEMPLATES.filter((template) => template.providerCode === providerCode);
}

export function findTemplate(providerCode: string, code: string): ModelTemplate | undefined {
  return MODEL_TEMPLATES.find(
    (template) => template.providerCode === providerCode && template.code === code,
  );
}

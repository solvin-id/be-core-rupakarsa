import { createHash, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { env } from "../env.js";
import { AppError } from "../http/errors.js";
import type { RenderAdapter, RenderRequest, RenderResult, StorageDriver } from "./types.js";

export const GRADIENT_VARIANTS: ReadonlyArray<readonly [string, string, string]> = [
  ["#ffd166", "#f04e23", "#7c2d12"],
  ["#e9e3ff", "#7c5cff", "#2e1065"],
  ["#f4ffd6", "#c8f169", "#3f6212"],
  ["#dbeafe", "#38bdf8", "#0c4a6e"],
  ["#fff1e6", "#ffb38a", "#9a3412"],
  ["#ffffff", "#a3a3a3", "#171717"],
  ["#fff7ed", "#d6b98c", "#78350f"],
  ["#c4b5fd", "#7c3aed", "#020617"],
];

const RENDER_DELAY_MS = 1200;
const MAX_TEXT_CHARS = 900;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function wrap(text: string, width: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > width && current) {
      lines.push(current);
      current = word;
      if (lines.length >= maxLines) return lines;
    } else {
      current = candidate;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  return lines;
}

export function variantFor(generationId: string): readonly [string, string, string] {
  const index = createHash("sha256").update(generationId).digest()[0]! % GRADIENT_VARIANTS.length;
  return GRADIENT_VARIANTS[index]!;
}

export function buildPosterSvg(
  generationId: string,
  input: Pick<RenderRequest, "prompt" | "modelName" | "mediaType" | "selectedParams">,
): string {
  const [start, middle, end] = variantFor(generationId);
  const prompt = input.prompt.replace(/\s+/g, " ").slice(0, MAX_TEXT_CHARS);
  const lines = wrap(prompt, 62, 8);
  const duration =
    input.mediaType === "VIDEO" && input.selectedParams.durationSec
      ? `${input.selectedParams.durationSec}s`
      : "IMAGE";
  const meta = [
    duration,
    input.selectedParams.resolution,
    input.selectedParams.aspectRatio,
  ].join("  ·  ");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" width="1280" height="720" role="img" aria-label="${escapeXml(input.modelName)}">
  <defs>
    <linearGradient id="poster" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${start}"/>
      <stop offset="55%" stop-color="${middle}"/>
      <stop offset="100%" stop-color="${end}"/>
    </linearGradient>
  </defs>
  <rect width="1280" height="720" fill="url(#poster)"/>
  <circle cx="1080" cy="120" r="220" fill="#ffffff" fill-opacity="0.12"/>
  <circle cx="180" cy="640" r="260" fill="#000000" fill-opacity="0.12"/>
  <text x="72" y="88" fill="#ffffff" fill-opacity="0.72" font-family="ui-sans-serif, system-ui, sans-serif" font-size="18" font-weight="500">RUPAKARSA · STUB RENDER</text>
  <text x="72" y="190" fill="#ffffff" font-family="ui-sans-serif, system-ui, sans-serif" font-size="56" font-weight="600">${escapeXml(input.modelName)}</text>
${lines
  .map(
    (line, index) =>
      `  <text x="72" y="${252 + index * 40}" fill="#ffffff" fill-opacity="0.82" font-family="ui-sans-serif, system-ui, sans-serif" font-size="26">${escapeXml(line)}</text>`,
  )
  .join("\n")}
  <text x="72" y="640" fill="#ffffff" fill-opacity="0.7" font-family="ui-monospace, monospace" font-size="20" font-weight="500">${escapeXml(meta)}</text>
</svg>
`;
}

export class StubRenderAdapter implements RenderAdapter {
  private readonly storage: StorageDriver;

  constructor(storage: StorageDriver) {
    this.storage = storage;
  }

  async render(input: RenderRequest, signal: AbortSignal): Promise<RenderResult> {
    await wait(RENDER_DELAY_MS, signal);

    if (input.simulateFailure && env.SIMULATION_MODE) {
      throw new AppError(502, "PROVIDER_ERROR", "Provider menolak render.");
    }

    const key = `generations/${input.generationId}.svg`;
    const svg = buildPosterSvg(input.generationId, input);
    await this.storage.put(key, Buffer.from(svg, "utf8"), "image/svg+xml");

    return { outputKey: key, externalJobId: `stub_${randomBytes(4).toString("hex")}` };
  }
}

async function wait(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await delay(ms, undefined, { signal });
  } catch {
    throw new AppError(504, "PROVIDER_TIMEOUT", "Render melewati batas waktu.");
  }
}

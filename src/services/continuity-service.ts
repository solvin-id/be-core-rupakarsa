import { and, asc, desc, eq, inArray } from "drizzle-orm";

import type { DbHandle } from "../db/client.js";
import { folderContexts, generations } from "../db/schema.js";

/** Same ceiling the pre-context service used, so a long project still fits one prompt budget. */
export const MAX_CONTINUITY_CHARS = 6000;
const PREVIOUS_PROMPT_CHARS = 1200;
const PREVIOUS_VISUAL_CHARS = 800;

export interface ContinuityScene {
  id: string;
  sequence: number;
  plannedPrompt: string;
  analysisSnapshot: string;
  outputKey: string | null;
  mediaType: "VIDEO" | "IMAGE";
}

export interface ContinuityResult {
  /** `[STYLE ANCHORS]` plus, when enabled, `[PREVIOUS SCENE]` and `[SCENE DIRECTION]`. */
  text: string;
  /** Latest completed scene of the folder, available for auto-attaching as a reference. */
  previous: ContinuityScene | null;
}

const SCENE_DIRECTION =
  "This render is the next scene of the same film. Keep subject identity, wardrobe, production " +
  "design, palette, lens and grade identical to the previous scene. Change only the action, " +
  "blocking and camera position described in the brief. Do not restyle and do not reuse the " +
  "previous framing.";

function clip(text: string, limit: number): string {
  const body = text.trim();
  return body.length > limit ? `${body.slice(0, limit).trimEnd()}…` : body;
}

/** Cuts at a line boundary so a project note is never truncated mid-sentence. */
function fitToBudget(sections: string[]): string {
  const lines: string[] = [];
  let total = 0;
  for (const raw of sections.join("\n\n").split("\n")) {
    if (total + raw.length + 1 > MAX_CONTINUITY_CHARS) {
      lines.push("…");
      break;
    }
    lines.push(raw);
    total += raw.length + 1;
  }
  return lines.join("\n").trim();
}

/**
 * Project continuity for one render: the durable style anchors of the folder plus the previous
 * completed scene, so consecutive clips keep one film's identity. Anchors alone are returned when
 * `includePrevious` is false.
 */
export async function loadContinuity(
  db: DbHandle,
  input: { folderId: string; contextIds?: string[]; includePrevious: boolean },
): Promise<ContinuityResult> {
  const conditions = [eq(folderContexts.folderId, input.folderId), eq(folderContexts.isActive, true)];
  if (input.contextIds && input.contextIds.length > 0) {
    conditions.push(inArray(folderContexts.id, input.contextIds));
  }

  const anchorRows = await db
    .select()
    .from(folderContexts)
    .where(and(...conditions))
    .orderBy(asc(folderContexts.createdAt));

  const anchorLines = anchorRows
    .map((row) => ({ label: row.label, body: row.text.trim() }))
    .filter((row) => row.body.length > 0)
    .map((row) => `- [${row.label}] ${row.body}`);

  if (!input.includePrevious) {
    return {
      text: anchorLines.length > 0 ? fitToBudget(["[STYLE ANCHORS]\n" + anchorLines.join("\n")]) : "",
      previous: null,
    };
  }

  const [previousRow] = await db
    .select()
    .from(generations)
    .where(and(eq(generations.folderId, input.folderId), eq(generations.status, "COMPLETED")))
    .orderBy(desc(generations.completedAt))
    .limit(1);

  const previous: ContinuityScene | null = previousRow
    ? {
        id: previousRow.id,
        sequence: previousRow.sequence,
        plannedPrompt: previousRow.plannedPrompt || previousRow.finalPrompt,
        analysisSnapshot: previousRow.analysisSnapshot,
        outputKey: previousRow.outputKey,
        mediaType: previousRow.mediaType,
      }
    : null;

  const sections: string[] = [];
  if (anchorLines.length > 0) sections.push(`[STYLE ANCHORS]\n${anchorLines.join("\n")}`);
  if (previous) {
    sections.push(
      [
        "[PREVIOUS SCENE]",
        `scene: ${previous.sequence} — ${clip(previous.plannedPrompt, PREVIOUS_PROMPT_CHARS)}`,
        previous.analysisSnapshot.trim().length > 0
          ? `visual: ${clip(previous.analysisSnapshot, PREVIOUS_VISUAL_CHARS)}`
          : null,
        "",
        "[SCENE DIRECTION]",
        SCENE_DIRECTION,
      ]
        .filter((line): line is string => line !== null)
        .join("\n"),
    );
  }

  return { text: sections.length > 0 ? fitToBudget(sections) : "", previous };
}

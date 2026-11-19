import { and, asc, eq, inArray } from "drizzle-orm";

import type { DbHandle } from "../db/client.js";
import { folderContexts, generations } from "../db/schema.js";

/** Same ceiling the pre-context service used, so a long project still fits one prompt budget. */
export const MAX_CONTINUITY_CHARS = 6000;
const SCENE_PROMPT_CHARS = 600;
const SCENE_VISUAL_CHARS = 400;

export interface ContinuityScene {
  id: string;
  sequence: number;
  plannedPrompt: string;
  analysisSnapshot: string;
  outputKey: string | null;
  mediaType: "VIDEO" | "IMAGE";
}

export interface ContinuityResult {
  /** `[STYLE ANCHORS]`, one `[SCENE n]` per selected scene, and `[SCENE DIRECTION]`. */
  text: string;
  /** Latest selected scene, available for auto-attaching as a reference. */
  previous: ContinuityScene | null;
  /** Selected completed scenes in ascending sequence order. */
  scenes: ContinuityScene[];
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
 * Project continuity for one render: the durable style anchors of the folder plus the explicitly
 * selected completed scenes, so each clip keeps one film's identity. No ids means anchors only;
 * ids that no longer exist or are not completed are dropped instead of failing the render.
 */
export async function loadContinuity(
  db: DbHandle,
  input: { folderId: string; contextIds?: string[]; chainSceneIds: string[] },
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

  if (input.chainSceneIds.length === 0) {
    return {
      text: anchorLines.length > 0 ? fitToBudget(["[STYLE ANCHORS]\n" + anchorLines.join("\n")]) : "",
      previous: null,
      scenes: [],
    };
  }

  const sceneRows = await db
    .select()
    .from(generations)
    .where(
      and(
        eq(generations.folderId, input.folderId),
        eq(generations.status, "COMPLETED"),
        inArray(generations.id, input.chainSceneIds),
      ),
    )
    .orderBy(asc(generations.sequence));

  const scenes: ContinuityScene[] = sceneRows.map((row) => ({
    id: row.id,
    sequence: row.sequence,
    plannedPrompt: row.plannedPrompt || row.finalPrompt,
    analysisSnapshot: row.analysisSnapshot,
    outputKey: row.outputKey,
    mediaType: row.mediaType,
  }));
  const previous = scenes[scenes.length - 1] ?? null;

  const sections: string[] = [];
  if (anchorLines.length > 0) sections.push(`[STYLE ANCHORS]\n${anchorLines.join("\n")}`);
  for (const scene of scenes) {
    sections.push(
      [
        `[SCENE ${scene.sequence}]`,
        `scene: ${clip(scene.plannedPrompt, SCENE_PROMPT_CHARS)}`,
        scene.analysisSnapshot.trim().length > 0
          ? `visual: ${clip(scene.analysisSnapshot, SCENE_VISUAL_CHARS)}`
          : null,
      ]
        .filter((line): line is string => line !== null)
        .join("\n"),
    );
  }
  if (scenes.length > 0) sections.push(`[SCENE DIRECTION]\n${SCENE_DIRECTION}`);

  return { text: sections.length > 0 ? fitToBudget(sections) : "", previous, scenes };
}

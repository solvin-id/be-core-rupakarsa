import type { AiModelRow } from "../db/schema.js";

/**
 * Request fields a provider workflow accepts. Higgsfield rejects any field its workflow does not
 * declare, so the declaration travels with the model row (`sync_metadata.requestFields`).
 */
export type ModelRequestField =
  | "duration"
  | "resolution"
  | "aspectRatio"
  | "image"
  | "imageUrls"
  | "videoUrls"
  | "thinking"
  | "customReference";

const KNOWN_FIELDS: Record<ModelRequestField, true> = {
  duration: true,
  resolution: true,
  aspectRatio: true,
  image: true,
  imageUrls: true,
  videoUrls: true,
  thinking: true,
  customReference: true,
};

/** Every render workflow accepts its render options unless it says otherwise. */
export const DEFAULT_REQUEST_FIELDS: readonly ModelRequestField[] = [
  "duration",
  "resolution",
  "aspectRatio",
];

export function declaredRequestFields(model: Pick<AiModelRow, "syncMetadata">): ModelRequestField[] | null {
  const raw = (model.syncMetadata as { requestFields?: unknown }).requestFields;
  if (!Array.isArray(raw)) return null;
  const fields = raw.filter(
    (field): field is ModelRequestField => typeof field === "string" && field in KNOWN_FIELDS,
  );
  return fields.length > 0 ? fields : null;
}

export function requestFieldsOf(model: Pick<AiModelRow, "syncMetadata">): ModelRequestField[] {
  return declaredRequestFields(model) ?? [...DEFAULT_REQUEST_FIELDS];
}

/**
 * A workflow takes a single first-frame image (`image`) or a reference set (`imageUrls`). Only an
 * explicit declaration counts, so continuity never sends a field a workflow would reject.
 */
export function modelSupportsImageReference(model: Pick<AiModelRow, "syncMetadata">): boolean {
  const fields = declaredRequestFields(model);
  if (!fields) return false;
  return fields.includes("image") || fields.includes("imageUrls");
}

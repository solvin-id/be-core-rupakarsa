import { and, asc, eq, inArray } from "drizzle-orm";

import type { DbHandle } from "../db/client.js";
import { folderContexts } from "../db/schema.js";

export const MAX_CONTEXT_CHARS = 6000;

/**
 * Project pre-context, oldest first, one `- [label] text` line per row. Long projects are cut at a
 * line boundary with an ellipsis so a brief is never truncated mid-sentence.
 */
export async function loadContextText(
  db: DbHandle,
  folderId: string,
  contextIds?: string[],
): Promise<string> {
  const conditions = [eq(folderContexts.folderId, folderId), eq(folderContexts.isActive, true)];
  if (contextIds && contextIds.length > 0) {
    conditions.push(inArray(folderContexts.id, contextIds));
  }

  const rows = await db
    .select()
    .from(folderContexts)
    .where(and(...conditions))
    .orderBy(asc(folderContexts.createdAt));

  const lines: string[] = [];
  let total = 0;
  for (const row of rows) {
    const body = row.text.trim();
    if (body.length === 0) continue;
    const line = `- [${row.label}] ${body}`;
    if (total + line.length + 1 > MAX_CONTEXT_CHARS) {
      lines.push("…");
      break;
    }
    lines.push(line);
    total += line.length + 1;
  }

  return lines.join("\n");
}

import { and, eq, gte, sql } from "drizzle-orm";

import type { DbHandle } from "../db/client.js";
import { db } from "../db/client.js";
import { generations } from "../db/schema.js";
import { conflict } from "../http/errors.js";
import { getLimitsSettings } from "./settings.js";

function startOfUtcDay(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export async function assertDailyGenerationQuota(
  workspaceId: string,
  handle: DbHandle = db,
): Promise<void> {
  const { generationsPerDayPerWorkspace } = await getLimitsSettings(handle);
  if (generationsPerDayPerWorkspace <= 0) return;

  const [row] = await handle
    .select({ count: sql<number>`count(*)`.mapWith(Number) })
    .from(generations)
    .where(
      and(
        eq(generations.workspaceId, workspaceId),
        gte(generations.createdAt, startOfUtcDay()),
      ),
    );

  if ((row?.count ?? 0) >= generationsPerDayPerWorkspace) {
    throw conflict("Kuota generasi harian workspace ini sudah habis.");
  }
}

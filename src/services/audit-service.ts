import type { DbHandle } from "../db/client.js";
import { auditLogs } from "../db/schema.js";
import { logger } from "../logger.js";

export interface AuditInput {
  actorUserId: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  ip?: string;
}

/**
 * Append-only operator trail. A failed audit write must never fail the request it describes, so
 * errors are logged and swallowed.
 */
export async function logAudit(db: DbHandle, input: AuditInput): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      actorUserId: input.actorUserId,
      action: input.action,
      targetType: input.targetType ?? "",
      targetId: input.targetId ?? "",
      metadata: input.metadata ?? {},
      ip: input.ip ?? "",
    });
  } catch (error) {
    logger.warn({ err: error, action: input.action }, "audit log write failed");
  }
}

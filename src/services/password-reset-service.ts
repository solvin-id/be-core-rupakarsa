import { createHash, randomBytes } from "node:crypto";

import { and, eq, gt, isNull } from "drizzle-orm";

import { hashPassword } from "../auth/password.js";
import { destroyUserSessions } from "../auth/session.js";
import { db } from "../db/client.js";
import { passwordResetTokens, users } from "../db/schema.js";
import type { UserRow } from "../db/schema.js";
import { env } from "../env.js";
import { validation } from "../http/errors.js";
import { assertPasswordPolicy } from "../auth/password-policy.js";
import { queueMail } from "./mail-service.js";

const TOKEN_TTL_MS = 60 * 60 * 1000;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Always resolves: the caller answers 200 even for unknown emails so account existence never leaks
 * through this endpoint.
 */
export async function requestPasswordReset(email: string, ip: string): Promise<void> {
  const normalized = email.trim().toLowerCase();
  const [user] = await db.select().from(users).where(eq(users.email, normalized)).limit(1);
  if (!user || !user.isActive || user.deletedAt) return;

  const token = randomBytes(32).toString("base64url");
  await db.insert(passwordResetTokens).values({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
    requestedIp: ip,
  });

  await queueMail({
    to: user.email,
    template: "PASSWORD_RESET",
    data: {
      fullName: user.fullName,
      resetUrl: `${env.PUBLIC_CREATOR_URL}/reset-password?token=${token}`,
    },
  });
}

export async function consumePasswordReset(token: string, newPassword: string): Promise<UserRow> {
  assertPasswordPolicy(newPassword);

  const [row] = await db
    .select()
    .from(passwordResetTokens)
    .where(
      and(
        eq(passwordResetTokens.tokenHash, hashToken(token)),
        isNull(passwordResetTokens.usedAt),
        gt(passwordResetTokens.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (!row) throw validation("Link reset password tidak valid atau kedaluwarsa.");

  const [user] = await db.select().from(users).where(eq(users.id, row.userId)).limit(1);
  if (!user || user.deletedAt) throw validation("Link reset password tidak valid atau kedaluwarsa.");

  const passwordHash = await hashPassword(newPassword);
  await db.update(users).set({ passwordHash }).where(eq(users.id, user.id));
  await db.update(passwordResetTokens).set({ usedAt: new Date() }).where(eq(passwordResetTokens.id, row.id));
  await destroyUserSessions(user.id);

  return user;
}

import { createHash, randomBytes } from "node:crypto";

import { and, eq, gt } from "drizzle-orm";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import { db } from "../db/client.js";
import { sessions } from "../db/schema.js";
import type { SessionRow } from "../db/schema.js";
import { env } from "../env.js";

export const SESSION_COOKIE = "rupakarsa_session";
const TOUCH_INTERVAL_MS = 60_000;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function expiryDate(): Date {
  return new Date(Date.now() + env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
}

export interface CreatedSession {
  session: SessionRow;
  token: string;
}

export async function createSession(
  userId: string,
  workspaceId: string | null,
): Promise<CreatedSession> {
  const token = randomBytes(32).toString("base64url");
  const [session] = await db
    .insert(sessions)
    .values({
      userId,
      tokenHash: hashToken(token),
      activeWorkspaceId: workspaceId,
      expiresAt: expiryDate(),
    })
    .returning();

  if (!session) throw new Error("Failed to create a session row.");
  return { session, token };
}

export function writeSessionCookie(c: Context, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: env.NODE_ENV === "production",
    domain: env.COOKIE_DOMAIN.length > 0 ? env.COOKIE_DOMAIN : undefined,
    path: "/",
    maxAge: env.SESSION_TTL_DAYS * 24 * 60 * 60,
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, {
    path: "/",
    domain: env.COOKIE_DOMAIN.length > 0 ? env.COOKIE_DOMAIN : undefined,
  });
}

export async function readSession(c: Context): Promise<SessionRow | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;

  const [row] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);

  return row ?? null;
}

export async function touchSession(session: SessionRow): Promise<void> {
  if (Date.now() - session.lastSeenAt.getTime() < TOUCH_INTERVAL_MS) return;
  await db.update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.id, session.id));
}

export async function destroySession(sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

export async function destroyUserSessions(userId: string, keepSessionId?: string): Promise<void> {
  const rows = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, userId));
  for (const row of rows) {
    if (row.id === keepSessionId) continue;
    await db.delete(sessions).where(eq(sessions.id, row.id));
  }
}

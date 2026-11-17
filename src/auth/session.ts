import { createHash, randomBytes } from "node:crypto";

import { and, eq, gt } from "drizzle-orm";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import { db } from "../db/client.js";
import { sessions } from "../db/schema.js";
import type { SessionRow } from "../db/schema.js";
import { env } from "../env.js";

export const SESSION_COOKIE = "rupakarsa_session";
export const CSRF_COOKIE = "rupakarsa_csrf";
const TOUCH_INTERVAL_MS = 60_000;

/**
 * Every value the browser sent for one cookie name. Duplicates are legal: a host-only cookie left
 * by an older deploy is sent alongside the domain-scoped one, and which of them a browser puts first
 * is not something the server can assume.
 */
export function cookieValues(c: Context, name: string): string[] {
  const raw = c.req.header("cookie") ?? "";
  const values: string[] = [];
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    try {
      values.push(decodeURIComponent(value));
    } catch {
      values.push(value);
    }
  }
  return values;
}

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

function cookieAttributes(): {
  sameSite: "Lax";
  secure: boolean;
  domain: string | undefined;
  path: string;
  maxAge: number;
} {
  return {
    sameSite: "Lax",
    secure: env.NODE_ENV === "production",
    domain: env.COOKIE_DOMAIN.length > 0 ? env.COOKIE_DOMAIN : undefined,
    path: "/",
    maxAge: env.SESSION_TTL_DAYS * 24 * 60 * 60,
  };
}

/**
 * Mints the page-readable double-submit token. Sessions created before this cookie existed carry no
 * csrf value, and the page can neither read nor send one, so `csrfMiddleware` also calls this when a
 * browser presents a session cookie without it.
 */
export function writeCsrfCookie(c: Context): string {
  const token = randomBytes(18).toString("base64url");
  setCookie(c, CSRF_COOKIE, token, { ...cookieAttributes(), httpOnly: false });
  return token;
}

export function writeSessionCookie(c: Context, token: string): void {
  // A deploy that ran before COOKIE_DOMAIN was set left host-only cookies on the API host. They are
  // still sent (and sort first), so expire them here; only the shared domain cookie remains.
  if (env.COOKIE_DOMAIN.length > 0) {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    deleteCookie(c, CSRF_COOKIE, { path: "/" });
  }
  setCookie(c, SESSION_COOKIE, token, { ...cookieAttributes(), httpOnly: true });
  writeCsrfCookie(c);
}

export function clearSessionCookie(c: Context): void {
  // When a shared domain is configured, also delete host-only duplicates left by an older deploy.
  if (env.COOKIE_DOMAIN.length > 0) {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    deleteCookie(c, CSRF_COOKIE, { path: "/" });
  }
  deleteCookie(c, SESSION_COOKIE, {
    path: "/",
    domain: env.COOKIE_DOMAIN.length > 0 ? env.COOKIE_DOMAIN : undefined,
  });
  deleteCookie(c, CSRF_COOKIE, {
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

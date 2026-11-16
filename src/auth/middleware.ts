import { and, eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";

import { db } from "../db/client.js";
import { users, workspaceMemberships } from "../db/schema.js";
import type { WorkspaceMembershipRow } from "../db/schema.js";
import { forbidden, unauthorized } from "../http/errors.js";
import type { AppBindings } from "../http/types.js";
import { getSecuritySettings } from "../services/settings.js";
import { readSession, touchSession } from "./session.js";

export function sessionGuard(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const session = await readSession(c);
    if (!session) throw unauthorized();

    const [user] = await db.select().from(users).where(eq(users.id, session.userId)).limit(1);
    if (!user) throw unauthorized();
    if (!user.isActive) {
      throw unauthorized("Akun ini sedang tidak aktif. Hubungi Superadmin.");
    }

    c.set("auth", { user, sessionId: session.id, workspaceId: session.activeWorkspaceId });
    await touchSession(session);
    await next();
  };
}

export function requireCms(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const auth = c.get("auth");
    const allowed = auth.user.role === "SUPERADMIN" || auth.user.cmsAccess;
    if (!allowed) throw forbidden("Akun ini tidak memiliki akses CMS.");

    const security = await getSecuritySettings(db);
    if (security.requireTotpForCms && !auth.user.totpEnabled) {
      throw forbidden("Aktifkan 2FA terlebih dahulu di Creator → Keamanan.");
    }
    await next();
  };
}

const ROLE_RANK: Record<"MEMBER" | "ADMIN" | "OWNER", number> = {
  MEMBER: 1,
  ADMIN: 2,
  OWNER: 3,
};

export function roleAtLeast(
  role: "MEMBER" | "ADMIN" | "OWNER",
  minimum: "MEMBER" | "ADMIN" | "OWNER",
): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

export interface WorkspaceScope {
  workspaceId: string;
  membership: WorkspaceMembershipRow;
}

export function requireWorkspace(
  minimum: "MEMBER" | "ADMIN" | "OWNER",
): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const auth = c.get("auth");
    if (!auth.workspaceId) {
      throw forbidden("Akun ini belum memiliki workspace. Hubungi Superadmin Rupakarsa.");
    }

    const [membership] = await db
      .select()
      .from(workspaceMemberships)
      .where(
        and(
          eq(workspaceMemberships.workspaceId, auth.workspaceId),
          eq(workspaceMemberships.userId, auth.user.id),
        ),
      )
      .limit(1);

    if (!membership) {
      throw forbidden("Anda bukan anggota workspace aktif ini.");
    }
    if (!roleAtLeast(membership.role, minimum)) {
      throw forbidden("Anda tidak memiliki izin untuk tindakan ini.");
    }

    c.set("membership", membership);
    await next();
  };
}

/** Membership of the caller in the given workspace, or null. */
export async function findMembership(
  workspaceId: string,
  userId: string,
): Promise<WorkspaceMembershipRow | null> {
  const [membership] = await db
    .select()
    .from(workspaceMemberships)
    .where(
      and(eq(workspaceMemberships.workspaceId, workspaceId), eq(workspaceMemberships.userId, userId)),
    )
    .limit(1);
  return membership ?? null;
}

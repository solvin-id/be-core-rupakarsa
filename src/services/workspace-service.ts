import { and, eq, inArray, ne } from "drizzle-orm";

import type { DbHandle, Tx } from "../db/client.js";
import { db } from "../db/client.js";
import {
  sessions,
  users,
  workspaceJoinRequests,
  workspaceMemberships,
  workspaces,
} from "../db/schema.js";
import type {
  UserRow,
  WorkspaceJoinRequestRow,
  WorkspaceMembershipRow,
  WorkspaceRow,
} from "../db/schema.js";
import { forbidden, notFound } from "../http/errors.js";
import {
  toMembership,
  toRequestSummary,
  toUser,
  toWorkspace,
} from "../http/serialize.js";
import type {
  MyJoinRequestDto,
  SessionPayloadDto,
  WorkspacesPayloadDto,
} from "../http/schemas.js";
import { slugify } from "./slug.js";

export interface MembershipWithWorkspace {
  membership: WorkspaceMembershipRow;
  workspace: WorkspaceRow;
}

const NO_WORKSPACE_MESSAGE = "Akun ini belum memiliki workspace. Hubungi Superadmin Rupakarsa.";

export async function loadMemberships(
  db: DbHandle,
  userId: string,
): Promise<MembershipWithWorkspace[]> {
  const rows = await db
    .select({ membership: workspaceMemberships, workspace: workspaces })
    .from(workspaceMemberships)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
    .where(eq(workspaceMemberships.userId, userId))
    .orderBy(workspaces.createdAt, workspaces.name);

  return rows.map((row) => ({ membership: row.membership, workspace: row.workspace }));
}

export interface ResolvedSession {
  payload: SessionPayloadDto;
  activeWorkspaceId: string;
}

/**
 * Resolves the session's active workspace on every read, persisting the outcome on the session.
 * An inactive workspace is still returned so the Creator can render its "Workspace tidak aktif" card.
 */
export async function setActiveWorkspace(sessionId: string, workspaceId: string): Promise<void> {
  await db.update(sessions).set({ activeWorkspaceId: workspaceId }).where(eq(sessions.id, sessionId));
}

export async function resolveSession(
  user: UserRow,
  sessionId: string,
  activeWorkspaceId: string | null,
): Promise<ResolvedSession> {
  const rows = await loadMemberships(db, user.id);
  if (rows.length === 0) throw forbidden(NO_WORKSPACE_MESSAGE);

  const byId = new Map(rows.map((row) => [row.workspace.id, row]));
  const chosen =
    (activeWorkspaceId ? byId.get(activeWorkspaceId) : undefined) ??
    (user.defaultWorkspaceId ? byId.get(user.defaultWorkspaceId) : undefined) ??
    rows.find((row) => row.workspace.isActive) ??
    rows[0];

  if (!chosen) throw forbidden(NO_WORKSPACE_MESSAGE);

  if (chosen.workspace.id !== activeWorkspaceId) {
    await db
      .update(sessions)
      .set({ activeWorkspaceId: chosen.workspace.id })
      .where(eq(sessions.id, sessionId));
  }

  return {
    activeWorkspaceId: chosen.workspace.id,
    payload: {
      user: toUser(user),
      workspace: toWorkspace(chosen.workspace),
      memberships: rows.map((row) => toMembership(row.membership)),
      workspaces: rows.map((row) => toWorkspace(row.workspace)),
      activeWorkspaceRole: chosen.membership.role,
    },
  };
}

export async function buildWorkspacesPayload(
  db: DbHandle,
  userId: string,
): Promise<WorkspacesPayloadDto> {
  const rows = await loadMemberships(db, userId);

  const managedIds = rows
    .filter((row) => row.membership.role === "OWNER" || row.membership.role === "ADMIN")
    .map((row) => row.workspace.id);

  const manageableRequests =
    managedIds.length === 0
      ? []
      : await db
          .select({ request: workspaceJoinRequests, user: users })
          .from(workspaceJoinRequests)
          .innerJoin(users, eq(users.id, workspaceJoinRequests.userId))
          .where(
            and(
              inArray(workspaceJoinRequests.workspaceId, managedIds),
              eq(workspaceJoinRequests.status, "PENDING"),
            ),
          )
          .orderBy(workspaceJoinRequests.createdAt);

  const myRequests = await db
    .select({ request: workspaceJoinRequests, workspace: workspaces })
    .from(workspaceJoinRequests)
    .innerJoin(workspaces, eq(workspaces.id, workspaceJoinRequests.workspaceId))
    .where(eq(workspaceJoinRequests.userId, userId))
    .orderBy(workspaceJoinRequests.createdAt);

  const myRequestDtos: MyJoinRequestDto[] = myRequests
    .map((row) => ({
      id: row.request.id,
      workspaceId: row.request.workspaceId,
      userId: row.request.userId,
      message: row.request.message,
      status: row.request.status,
      createdAt: row.request.createdAt.toISOString(),
      resolvedAt: row.request.resolvedAt ? row.request.resolvedAt.toISOString() : null,
      resolvedByUserId: row.request.resolvedByUserId,
      workspace: {
        id: row.workspace.id,
        name: row.workspace.name,
        slug: row.workspace.slug,
      },
    }))
    .reverse();

  return {
    workspaces: rows.map((row) => toWorkspace(row.workspace)),
    memberships: rows.map((row) => toMembership(row.membership)),
    manageableRequests: manageableRequests.map((row) => toRequestSummary(row.request, row.user)),
    myRequests: myRequestDtos,
  };
}

export async function takenSlugs(db: DbHandle): Promise<Set<string>> {
  const rows = await db.select({ slug: workspaces.slug }).from(workspaces);
  return new Set(rows.map((row) => row.slug));
}

export function uniqueSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export interface CreateWorkspaceInput {
  name: string;
  slug?: string;
  ownerId: string;
  tokenBalance?: number;
  freePlanRemaining?: number;
  isActive?: boolean;
}

export async function createWorkspace(
  tx: Tx,
  input: CreateWorkspaceInput,
): Promise<WorkspaceRow> {
  const explicitSlug = Boolean(input.slug && input.slug.trim().length > 0);
  const base = slugify(explicitSlug ? (input.slug ?? "") : input.name);
  const taken = await takenSlugs(tx);

  if (explicitSlug && taken.has(base)) {
    throw new Error("SLUG_TAKEN");
  }
  const slug = explicitSlug ? base : uniqueSlug(base, taken);

  const [workspace] = await tx
    .insert(workspaces)
    .values({
      name: input.name,
      slug,
      tokenBalance: input.tokenBalance ?? 0,
      freePlanRemaining: input.freePlanRemaining ?? 0,
      isActive: input.isActive ?? true,
    })
    .returning();
  if (!workspace) throw new Error("WORKSPACE_INSERT_FAILED");

  await tx
    .insert(workspaceMemberships)
    .values({ workspaceId: workspace.id, userId: input.ownerId, role: "OWNER" });

  return workspace;
}

export async function loadWorkspace(db: DbHandle, workspaceId: string): Promise<WorkspaceRow> {
  const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (!row) throw notFound("Workspace tidak ditemukan.");
  return row;
}

/** Rewrites `users.default_workspace_id` when it points at a workspace the user is leaving. */
export async function relocateDefaultWorkspace(
  tx: Tx,
  userId: string,
  removedWorkspaceId: string,
): Promise<void> {
  const [user] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user || user.defaultWorkspaceId !== removedWorkspaceId) return;

  const remaining = await tx
    .select({ membership: workspaceMemberships, workspace: workspaces })
    .from(workspaceMemberships)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
    .where(
      and(
        eq(workspaceMemberships.userId, userId),
        ne(workspaceMemberships.workspaceId, removedWorkspaceId),
      ),
    )
    .orderBy(workspaces.createdAt);

  const fallback = remaining.find((row) => row.workspace.isActive) ?? remaining[0];
  if (!fallback) {
    await tx.update(users).set({ defaultWorkspaceId: null }).where(eq(users.id, userId));
    return;
  }

  await tx
    .update(users)
    .set({ defaultWorkspaceId: fallback.workspace.id })
    .where(eq(users.id, userId));
}

export async function membershipCount(db: DbHandle, userId: string): Promise<number> {
  const rows = await db
    .select({ id: workspaceMemberships.id })
    .from(workspaceMemberships)
    .where(eq(workspaceMemberships.userId, userId));
  return rows.length;
}

export interface PendingRequest {
  request: WorkspaceJoinRequestRow;
  workspace: WorkspaceRow;
}

export async function findJoinRequest(db: DbHandle, requestId: string): Promise<PendingRequest> {
  const [row] = await db
    .select({ request: workspaceJoinRequests, workspace: workspaces })
    .from(workspaceJoinRequests)
    .innerJoin(workspaces, eq(workspaces.id, workspaceJoinRequests.workspaceId))
    .where(eq(workspaceJoinRequests.id, requestId))
    .limit(1);
  if (!row) throw notFound("Permintaan tidak ditemukan.");
  return { request: row.request, workspace: row.workspace };
}

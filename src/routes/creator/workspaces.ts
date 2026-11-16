import { and, eq } from "drizzle-orm";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { roleAtLeast, sessionGuard } from "../../auth/middleware.js";
import { db } from "../../db/client.js";
import {
  users,
  workspaceJoinRequests,
  workspaceMemberships,
  workspaces,
} from "../../db/schema.js";
import type { WorkspaceMembershipRow } from "../../db/schema.js";
import { conflict, forbidden, notFound, validation } from "../../http/errors.js";
import { defaultHook } from "../../http/route-helpers.js";
import {
  toJoinRequest,
  toMemberSummary,
  toMembership,
  toWorkspace,
} from "../../http/serialize.js";
import {
  ErrorResponseSchema,
  SessionPayloadSchema,
  WorkspaceJoinRequestSchema,
  WorkspaceMemberSummarySchema,
  WorkspaceMembershipSchema,
  WorkspaceSchema,
  WorkspacesPayloadSchema,
} from "../../http/schemas.js";
import type { AppBindings } from "../../http/types.js";
import { slugify } from "../../services/slug.js";
import {
  buildWorkspacesPayload,
  findJoinRequest,
  loadMemberships,
  loadWorkspace,
  membershipCount,
  relocateDefaultWorkspace,
  resolveSession,
  setActiveWorkspace,
  takenSlugs,
  uniqueSlug,
} from "../../services/workspace-service.js";

export const creatorWorkspaceRoutes = new OpenAPIHono<AppBindings>({ defaultHook });

const errorContent = { "application/json": { schema: ErrorResponseSchema } };

const workspaceIdParams = z.object({ id: z.string().uuid() });
const memberParams = z.object({ id: z.string().uuid(), userId: z.string().uuid() });
const requestParams = z.object({ id: z.string().uuid() });

function nameError(): never {
  throw validation("Nama workspace minimal 2 karakter.");
}

async function requireActorRole(
  workspaceId: string,
  userId: string,
  message: string,
  minimum: "MEMBER" | "ADMIN" | "OWNER",
): Promise<WorkspaceMembershipRow> {
  const [actor] = await db
    .select()
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, userId),
      ),
    )
    .limit(1);
  if (!actor || !roleAtLeast(actor.role, minimum)) throw forbidden(message);
  return actor;
}

creatorWorkspaceRoutes.use("/workspaces", sessionGuard());
creatorWorkspaceRoutes.use("/workspaces/*", sessionGuard());
creatorWorkspaceRoutes.use("/join-requests", sessionGuard());
creatorWorkspaceRoutes.use("/join-requests/*", sessionGuard());

const listRoute = createRoute({
  method: "get",
  path: "/workspaces",
  tags: ["Creator workspaces"],
  responses: {
    200: {
      description: "Workspaces of the caller",
      content: { "application/json": { schema: WorkspacesPayloadSchema } },
    },
    401: { description: "No session", content: errorContent },
  },
});

creatorWorkspaceRoutes.openapi(listRoute, async (c) => {
  const auth = c.get("auth");
  return c.json(await buildWorkspacesPayload(db, auth.user.id), 200);
});

const createWorkspaceRoute = createRoute({
  method: "post",
  path: "/workspaces",
  tags: ["Creator workspaces"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string(),
            slug: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: { description: "Workspace created", content: { "application/json": { schema: WorkspaceSchema } } },
    400: { description: "Invalid name or slug", content: errorContent },
    409: { description: "Slug already used", content: errorContent },
  },
});

creatorWorkspaceRoutes.openapi(createWorkspaceRoute, async (c) => {
  const auth = c.get("auth");
  const body = c.req.valid("json");

  const name = body.name.trim();
  if (name.length < 2) nameError();

  const explicitSlug = Boolean(body.slug && body.slug.trim().length > 0);
  const base = slugify(explicitSlug ? (body.slug ?? "") : name);
  if (base.length < 2) throw validation("Slug workspace minimal 2 karakter.");

  const taken = await takenSlugs(db);
  if (explicitSlug && taken.has(base)) throw conflict("Slug workspace sudah dipakai.");
  const slug = explicitSlug ? base : uniqueSlug(base, taken);

  const created = await db.transaction(async (tx) => {
    const [workspace] = await tx
      .insert(workspaces)
      .values({ name, slug })
      .returning();
    if (!workspace) throw conflict("Workspace gagal dibuat.");
    await tx
      .insert(workspaceMemberships)
      .values({ workspaceId: workspace.id, userId: auth.user.id, role: "OWNER" });
    return workspace;
  });

  return c.json(toWorkspace(created), 201);
});

const activateRoute = createRoute({
  method: "post",
  path: "/workspaces/{id}/activate",
  tags: ["Creator workspaces"],
  request: { params: workspaceIdParams },
  responses: {
    200: { description: "Session payload", content: { "application/json": { schema: SessionPayloadSchema } } },
    403: { description: "Not a member or workspace inactive", content: errorContent },
    404: { description: "Workspace not found", content: errorContent },
  },
});

creatorWorkspaceRoutes.openapi(activateRoute, async (c) => {
  const auth = c.get("auth");
  const { id } = c.req.valid("param");

  const rows = await loadMemberships(db, auth.user.id);
  const target = rows.find((row) => row.workspace.id === id);
  if (!target) throw forbidden("Anda bukan anggota workspace ini.");
  if (!target.workspace.isActive) throw forbidden(`Workspace ${target.workspace.name} sedang tidak aktif.`);

  await setActiveWorkspace(auth.sessionId, id);
  const resolved = await resolveSession(auth.user, auth.sessionId, id);
  return c.json(resolved.payload, 200);
});

const renameRoute = createRoute({
  method: "patch",
  path: "/workspaces/{id}",
  tags: ["Creator workspaces"],
  request: {
    params: workspaceIdParams,
    body: {
      content: { "application/json": { schema: z.object({ name: z.string() }) } },
    },
  },
  responses: {
    200: { description: "Updated workspace", content: { "application/json": { schema: WorkspaceSchema } } },
    400: { description: "Invalid name", content: errorContent },
    403: { description: "Owner only", content: errorContent },
    404: { description: "Workspace not found", content: errorContent },
  },
});

creatorWorkspaceRoutes.openapi(renameRoute, async (c) => {
  const auth = c.get("auth");
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

  await requireActorRole(
    id,
    auth.user.id,
    "Hanya owner yang dapat mengubah nama workspace.",
    "OWNER",
  );

  const name = body.name.trim();
  if (name.length < 2) nameError();

  const [updated] = await db
    .update(workspaces)
    .set({ name })
    .where(eq(workspaces.id, id))
    .returning();
  if (!updated) throw notFound("Workspace tidak ditemukan.");
  return c.json(toWorkspace(updated), 200);
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/workspaces/{id}",
  tags: ["Creator workspaces"],
  request: { params: workspaceIdParams },
  responses: {
    204: { description: "Workspace deleted" },
    403: { description: "Owner only", content: errorContent },
    404: { description: "Workspace not found", content: errorContent },
    409: { description: "Member would be stranded", content: errorContent },
  },
});

creatorWorkspaceRoutes.openapi(deleteRoute, async (c) => {
  const auth = c.get("auth");
  const { id } = c.req.valid("param");

  await requireActorRole(id, auth.user.id, "Hanya owner yang dapat menghapus workspace.", "OWNER");
  const workspace = await loadWorkspace(db, id);

  const memberRows = await db
    .select({ membership: workspaceMemberships, user: users })
    .from(workspaceMemberships)
    .innerJoin(users, eq(users.id, workspaceMemberships.userId))
    .where(eq(workspaceMemberships.workspaceId, id));

  const stranded: string[] = [];
  for (const row of memberRows) {
    const total = await membershipCount(db, row.membership.userId);
    if (total <= 1) stranded.push(row.user.fullName);
  }
  if (stranded.length > 0) {
    throw conflict(
      `${stranded.join(", ")} hanya tergabung di ${workspace.name}. Tambahkan mereka ke workspace lain sebelum menghapus.`,
    );
  }

  await db.transaction(async (tx) => {
    for (const row of memberRows) {
      await relocateDefaultWorkspace(tx, row.membership.userId, id);
    }
    await tx.delete(workspaces).where(eq(workspaces.id, id));
  });

  return c.body(null, 204);
});

const leaveRoute = createRoute({
  method: "post",
  path: "/workspaces/{id}/leave",
  tags: ["Creator workspaces"],
  request: { params: workspaceIdParams },
  responses: {
    204: { description: "Left workspace" },
    403: { description: "Owner cannot leave", content: errorContent },
    409: { description: "Last workspace", content: errorContent },
  },
});

creatorWorkspaceRoutes.openapi(leaveRoute, async (c) => {
  const auth = c.get("auth");
  const { id } = c.req.valid("param");

  const [target] = await db
    .select()
    .from(workspaceMemberships)
    .where(
      and(eq(workspaceMemberships.workspaceId, id), eq(workspaceMemberships.userId, auth.user.id)),
    )
    .limit(1);
  if (!target) throw forbidden("Anda bukan anggota workspace ini.");
  if (target.role === "OWNER") {
    throw forbidden("Owner tidak dapat keluar. Hapus workspace bila tidak dipakai.");
  }
  if ((await membershipCount(db, auth.user.id)) <= 1) {
    throw conflict("Setiap akun harus punya minimal satu workspace.");
  }

  await db.transaction(async (tx) => {
    await tx.delete(workspaceMemberships).where(eq(workspaceMemberships.id, target.id));
    await relocateDefaultWorkspace(tx, auth.user.id, id);
  });

  return c.body(null, 204);
});

const membersRoute = createRoute({
  method: "get",
  path: "/workspaces/{id}/members",
  tags: ["Creator workspaces"],
  request: { params: workspaceIdParams },
  responses: {
    200: {
      description: "Workspace members",
      content: { "application/json": { schema: z.array(WorkspaceMemberSummarySchema) } },
    },
    403: { description: "Not a member", content: errorContent },
  },
});

creatorWorkspaceRoutes.openapi(membersRoute, async (c) => {
  const auth = c.get("auth");
  const { id } = c.req.valid("param");

  await requireActorRole(id, auth.user.id, "Anda bukan anggota workspace ini.", "MEMBER");

  const rows = await db
    .select({ membership: workspaceMemberships, user: users })
    .from(workspaceMemberships)
    .innerJoin(users, eq(users.id, workspaceMemberships.userId))
    .where(eq(workspaceMemberships.workspaceId, id))
    .orderBy(workspaceMemberships.joinedAt);

  return c.json(
    rows.map((row) => toMemberSummary(row.membership, row.user)),
    200,
  );
});

const roleRoute = createRoute({
  method: "patch",
  path: "/workspaces/{id}/members/{userId}",
  tags: ["Creator workspaces"],
  request: {
    params: memberParams,
    body: {
      content: {
        "application/json": { schema: z.object({ role: z.enum(["ADMIN", "MEMBER"]) }) },
      },
    },
  },
  responses: {
    200: {
      description: "Updated membership",
      content: { "application/json": { schema: WorkspaceMembershipSchema } },
    },
    403: { description: "Owner only", content: errorContent },
    404: { description: "Member not found", content: errorContent },
  },
});

creatorWorkspaceRoutes.openapi(roleRoute, async (c) => {
  const auth = c.get("auth");
  const { id, userId } = c.req.valid("param");
  const body = c.req.valid("json");

  await requireActorRole(id, auth.user.id, "Hanya owner yang dapat mengubah role anggota.", "OWNER");

  const [target] = await db
    .select()
    .from(workspaceMemberships)
    .where(
      and(eq(workspaceMemberships.workspaceId, id), eq(workspaceMemberships.userId, userId)),
    )
    .limit(1);
  if (!target) throw notFound("Anggota tidak ditemukan.");
  if (target.role === "OWNER") throw forbidden("Role owner tidak dapat diubah.");

  const [updated] = await db
    .update(workspaceMemberships)
    .set({ role: body.role })
    .where(eq(workspaceMemberships.id, target.id))
    .returning();
  if (!updated) throw notFound("Anggota tidak ditemukan.");

  return c.json(toMembership(updated), 200);
});

const removeMemberRoute = createRoute({
  method: "delete",
  path: "/workspaces/{id}/members/{userId}",
  tags: ["Creator workspaces"],
  request: { params: memberParams },
  responses: {
    204: { description: "Member removed" },
    403: { description: "Not allowed", content: errorContent },
    404: { description: "Member not found", content: errorContent },
    409: { description: "Member would be stranded", content: errorContent },
  },
});

creatorWorkspaceRoutes.openapi(removeMemberRoute, async (c) => {
  const auth = c.get("auth");
  const { id, userId } = c.req.valid("param");

  const actor = await requireActorRole(
    id,
    auth.user.id,
    "Hanya owner atau admin yang dapat mengeluarkan anggota.",
    "ADMIN",
  );

  const [target] = await db
    .select()
    .from(workspaceMemberships)
    .where(
      and(eq(workspaceMemberships.workspaceId, id), eq(workspaceMemberships.userId, userId)),
    )
    .limit(1);
  if (!target) throw notFound("Anggota tidak ditemukan.");
  if (target.role === "OWNER") throw forbidden("Owner tidak dapat dikeluarkan dari workspace.");
  if (actor.role === "ADMIN" && target.role === "ADMIN") {
    throw forbidden("Admin tidak dapat mengeluarkan admin lain.");
  }
  if (userId === auth.user.id) {
    throw forbidden("Gunakan Keluar untuk meninggalkan workspace.");
  }

  if ((await membershipCount(db, userId)) <= 1) {
    const [member] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    throw conflict(`${member?.fullName ?? userId} hanya tergabung di workspace ini.`);
  }

  await db.transaction(async (tx) => {
    await tx.delete(workspaceMemberships).where(eq(workspaceMemberships.id, target.id));
    await relocateDefaultWorkspace(tx, userId, id);
  });

  return c.body(null, 204);
});

const requestJoinRoute = createRoute({
  method: "post",
  path: "/join-requests",
  tags: ["Creator workspaces"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ slug: z.string(), message: z.string().optional() }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Join request created",
      content: { "application/json": { schema: WorkspaceJoinRequestSchema } },
    },
    404: { description: "Workspace not found", content: errorContent },
    409: { description: "Already member or pending", content: errorContent },
  },
});

creatorWorkspaceRoutes.openapi(requestJoinRoute, async (c) => {
  const auth = c.get("auth");
  const body = c.req.valid("json");
  const slug = body.slug.trim().toLowerCase();

  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.slug, slug)).limit(1);
  if (!workspace) throw notFound("Workspace dengan slug tersebut tidak ditemukan.");
  if (!workspace.isActive) throw conflict("Workspace ini sedang tidak aktif.");

  const [existingMembership] = await db
    .select({ id: workspaceMemberships.id })
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspace.id),
        eq(workspaceMemberships.userId, auth.user.id),
      ),
    )
    .limit(1);
  if (existingMembership) throw conflict("Anda sudah menjadi anggota workspace ini.");

  const [pending] = await db
    .select({ id: workspaceJoinRequests.id })
    .from(workspaceJoinRequests)
    .where(
      and(
        eq(workspaceJoinRequests.workspaceId, workspace.id),
        eq(workspaceJoinRequests.userId, auth.user.id),
        eq(workspaceJoinRequests.status, "PENDING"),
      ),
    )
    .limit(1);
  if (pending) throw conflict("Permintaan Anda masih menunggu persetujuan.");

  const [request] = await db
    .insert(workspaceJoinRequests)
    .values({
      workspaceId: workspace.id,
      userId: auth.user.id,
      message: (body.message ?? "").trim(),
      status: "PENDING",
    })
    .returning();
  if (!request) throw conflict("Permintaan gagal dibuat.");

  return c.json(toJoinRequest(request), 201);
});

async function resolveJoinRequest(
  requestId: string,
  actorId: string,
  decision: "APPROVED" | "REJECTED",
  actorMessage: string,
): Promise<void> {
  const { request } = await findJoinRequest(db, requestId);
  if (request.status !== "PENDING") throw conflict("Permintaan sudah diproses.");

  await requireActorRole(request.workspaceId, actorId, actorMessage, "ADMIN");

  await db.transaction(async (tx) => {
    await tx
      .update(workspaceJoinRequests)
      .set({
        status: decision,
        resolvedAt: new Date(),
        resolvedByUserId: actorId,
      })
      .where(eq(workspaceJoinRequests.id, request.id));

    if (decision !== "APPROVED") return;

    const [existing] = await tx
      .select({ id: workspaceMemberships.id })
      .from(workspaceMemberships)
      .where(
        and(
          eq(workspaceMemberships.workspaceId, request.workspaceId),
          eq(workspaceMemberships.userId, request.userId),
        ),
      )
      .limit(1);
    if (existing) return;

    await tx
      .insert(workspaceMemberships)
      .values({ workspaceId: request.workspaceId, userId: request.userId, role: "MEMBER" });
  });
}

const approveRoute = createRoute({
  method: "post",
  path: "/join-requests/{id}/approve",
  tags: ["Creator workspaces"],
  request: { params: requestParams },
  responses: {
    204: { description: "Request approved" },
    403: { description: "Not allowed", content: errorContent },
    404: { description: "Request not found", content: errorContent },
    409: { description: "Already processed", content: errorContent },
  },
});

creatorWorkspaceRoutes.openapi(approveRoute, async (c) => {
  const auth = c.get("auth");
  const { id } = c.req.valid("param");
  await resolveJoinRequest(
    id,
    auth.user.id,
    "APPROVED",
    "Hanya owner atau admin yang dapat menyetujui permintaan.",
  );
  return c.body(null, 204);
});

const rejectRoute = createRoute({
  method: "post",
  path: "/join-requests/{id}/reject",
  tags: ["Creator workspaces"],
  request: { params: requestParams },
  responses: {
    204: { description: "Request rejected" },
    403: { description: "Not allowed", content: errorContent },
    404: { description: "Request not found", content: errorContent },
    409: { description: "Already processed", content: errorContent },
  },
});

creatorWorkspaceRoutes.openapi(rejectRoute, async (c) => {
  const auth = c.get("auth");
  const { id } = c.req.valid("param");
  await resolveJoinRequest(
    id,
    auth.user.id,
    "REJECTED",
    "Hanya owner atau admin yang dapat menolak permintaan.",
  );
  return c.body(null, 204);
});

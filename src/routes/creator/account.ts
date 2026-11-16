import { and, eq, lt, or } from "drizzle-orm";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { sessionGuard } from "../../auth/middleware.js";
import { verifyPassword } from "../../auth/password.js";
import { destroyUserSessions } from "../../auth/session.js";
import { db } from "../../db/client.js";
import {
  folderContexts,
  folders,
  generations,
  users,
  workspaceMemberships,
  workspaces,
} from "../../db/schema.js";
import { unauthorized, validation } from "../../http/errors.js";
import { defaultHook } from "../../http/route-helpers.js";
import { ErrorResponseSchema } from "../../http/schemas.js";
import type { AppBindings } from "../../http/types.js";

export const creatorAccountRoutes = new OpenAPIHono<AppBindings>({ defaultHook });

const errorContent = { "application/json": { schema: ErrorResponseSchema } };

creatorAccountRoutes.use("/account", sessionGuard());
creatorAccountRoutes.use("/account/*", sessionGuard());

const exportRoute = createRoute({
  method: "get",
  path: "/account/export",
  tags: ["Creator account"],
  responses: {
    200: {
      description: "Portable copy of the caller's data (never includes password_hash)",
      content: {
        "application/json": {
          schema: z.object({
            exportedAt: z.string(),
            user: z.record(z.unknown()),
            memberships: z.array(z.record(z.unknown())),
            workspaces: z.array(z.record(z.unknown())),
            folders: z.array(z.record(z.unknown())),
            generations: z.array(z.record(z.unknown())),
            contexts: z.array(z.record(z.unknown())),
          }),
        },
      },
    },
  },
});

creatorAccountRoutes.openapi(exportRoute, async (c) => {
  const auth = c.get("auth");
  const user = auth.user;

  const membershipRows = await db
    .select({ membership: workspaceMemberships, workspace: workspaces })
    .from(workspaceMemberships)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
    .where(eq(workspaceMemberships.userId, user.id));

  const workspaceIds = membershipRows.map((row) => row.workspace.id);

  const folderRows =
    workspaceIds.length > 0
      ? await db
          .select()
          .from(folders)
          .where(or(...workspaceIds.map((id) => eq(folders.workspaceId, id))))
      : [];

  const generationRows =
    workspaceIds.length > 0
      ? await db
          .select()
          .from(generations)
          .where(or(...workspaceIds.map((id) => eq(generations.workspaceId, id))))
      : [];

  const contextRows =
    workspaceIds.length > 0
      ? await db
          .select()
          .from(folderContexts)
          .where(or(...workspaceIds.map((id) => eq(folderContexts.workspaceId, id))))
      : [];

  return c.json(
    {
      exportedAt: new Date().toISOString(),
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        cmsAccess: user.cmsAccess,
        isActive: user.isActive,
        createdAt: user.createdAt.toISOString(),
      },
      memberships: membershipRows.map((row) => ({
        workspaceId: row.membership.workspaceId,
        role: row.membership.role,
        joinedAt: row.membership.joinedAt.toISOString(),
      })),
      workspaces: membershipRows.map((row) => ({
        id: row.workspace.id,
        name: row.workspace.name,
        slug: row.workspace.slug,
        createdAt: row.workspace.createdAt.toISOString(),
      })),
      folders: folderRows.map((row) => ({
        id: row.id,
        workspaceId: row.workspaceId,
        name: row.name,
        description: row.description,
        createdAt: row.createdAt.toISOString(),
      })),
      generations: generationRows.map((row) => ({
        id: row.id,
        workspaceId: row.workspaceId,
        folderId: row.folderId,
        rawPrompt: row.rawPrompt,
        finalPrompt: row.finalPrompt,
        mediaType: row.mediaType,
        status: row.status,
        tokensCharged: row.tokensCharged,
        createdAt: row.createdAt.toISOString(),
      })),
      contexts: contextRows.map((row) => ({
        id: row.id,
        folderId: row.folderId,
        source: row.source,
        label: row.label,
        text: row.text,
        isActive: row.isActive,
        createdAt: row.createdAt.toISOString(),
      })),
    },
    200,
  );
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/account",
  tags: ["Creator account"],
  request: {
    body: {
      content: {
        "application/json": { schema: z.object({ password: z.string().min(1) }) },
      },
    },
  },
  responses: {
    204: { description: "Account scheduled for deletion (30 day retention)" },
    400: { description: "Missing password", content: errorContent },
    401: { description: "Wrong password", content: errorContent },
  },
});

creatorAccountRoutes.openapi(deleteRoute, async (c) => {
  const auth = c.get("auth");
  const body = c.req.valid("json");

  if (body.password.length === 0) throw validation("Password wajib diisi.");
  const matches = await verifyPassword(body.password, auth.user.passwordHash);
  if (!matches) throw unauthorized("Password salah.");

  await db
    .update(users)
    .set({ deletedAt: new Date(), isActive: false })
    .where(eq(users.id, auth.user.id));
  await destroyUserSessions(auth.user.id);

  return c.body(null, 204);
});

/** Hard-deletes accounts whose retention window elapsed; owned workspaces survive. */
export async function purgeDeletedAccounts(): Promise<number> {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(lt(users.deletedAt, cutoff)));

  for (const row of rows) {
    await db.delete(users).where(eq(users.id, row.id));
  }
  return rows.length;
}

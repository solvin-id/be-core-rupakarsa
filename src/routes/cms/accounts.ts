import { randomUUID } from "node:crypto";

import { and, desc, eq, inArray } from "drizzle-orm";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { requireCms, sessionGuard } from "../../auth/middleware.js";
import { assertPasswordPolicy } from "../../auth/password-policy.js";
import { hashPassword } from "../../auth/password.js";
import { destroyUserSessions } from "../../auth/session.js";
import { db } from "../../db/client.js";
import { users, workspaceMemberships, workspaces } from "../../db/schema.js";
import { env } from "../../env.js";
import { conflict, notFound, validation } from "../../http/errors.js";
import { clientIp } from "../../http/middleware.js";
import { defaultHook } from "../../http/route-helpers.js";
import { toMembership, toUser } from "../../http/serialize.js";
import {
  AccountCreatedSchema,
  ErrorResponseSchema,
  RoleSchema,
  UserSchema,
  WorkspaceMembershipSchema,
} from "../../http/schemas.js";
import type { AppBindings } from "../../http/types.js";
import { logAudit } from "../../services/audit-service.js";
import { queueMail } from "../../services/mail-service.js";
import { slugify } from "../../services/slug.js";
import { membershipCount, relocateDefaultWorkspace } from "../../services/workspace-service.js";

export const cmsAccountRoutes = new OpenAPIHono<AppBindings>({ defaultHook });

const errorContent = { "application/json": { schema: ErrorResponseSchema } };
const accountParams = z.object({ id: z.string().uuid() });
const accountWorkspaceParams = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
});

/** Rejects ids that are unknown or point at an inactive workspace; callers dedupe first. */
async function assertActiveWorkspaces(ids: string[]): Promise<void> {
  const found = await db.select().from(workspaces).where(inArray(workspaces.id, ids));
  if (found.length !== ids.length) throw notFound("Workspace tidak ditemukan.");
  if (found.some((row) => !row.isActive)) throw validation("Workspace tidak aktif.");
}

cmsAccountRoutes.use("/accounts", sessionGuard(), requireCms());
cmsAccountRoutes.use("/accounts/*", sessionGuard(), requireCms());

const listRoute = createRoute({
  method: "get",
  path: "/accounts",
  tags: ["CMS accounts"],
  responses: {
    200: {
      description: "All accounts",
      content: { "application/json": { schema: z.array(UserSchema) } },
    },
    403: { description: "No CMS access", content: errorContent },
  },
});

cmsAccountRoutes.openapi(listRoute, async (c) => {
  const rows = await db.select().from(users).orderBy(desc(users.createdAt));
  return c.json(rows.map(toUser), 200);
});

const createAccountRoute = createRoute({
  method: "post",
  path: "/accounts",
  tags: ["CMS accounts"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            fullName: z.string(),
            email: z.string().email("Format email tidak valid."),
            role: RoleSchema,
            cmsAccess: z.boolean().default(false),
            workspaceMode: z.enum(["PERSONAL", "EXISTING"]).default("PERSONAL"),
            workspaceIds: z.array(z.string().uuid()).default([]),
            password: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Account created with a temporary password",
      content: { "application/json": { schema: AccountCreatedSchema } },
    },
    400: { description: "Invalid name", content: errorContent },
    409: { description: "Email already registered", content: errorContent },
  },
});

cmsAccountRoutes.openapi(createAccountRoute, async (c) => {
  const auth = c.get("auth");
  const body = c.req.valid("json");
  const fullName = body.fullName.trim();
  if (fullName.length < 2) throw validation("Nama akun minimal 2 karakter.");

  const email = body.email.trim().toLowerCase();
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing) throw conflict("Email sudah terdaftar.");

  const ids = [...new Set(body.workspaceIds)];
  if (body.workspaceMode === "PERSONAL" && ids.length > 0) {
    throw validation("Mode personal tidak menerima daftar workspace.");
  }
  if (body.workspaceMode === "EXISTING" && ids.length === 0) {
    throw validation("Pilih minimal satu workspace untuk akun ini.");
  }
  if (body.workspaceMode === "EXISTING") await assertActiveWorkspaces(ids);

  const customPassword = body.password?.trim() ?? "";
  if (customPassword.length > 0) assertPasswordPolicy(customPassword);

  const temporaryPassword =
    customPassword.length > 0
      ? customPassword
      : Buffer.from(randomUUID().replace(/-/g, ""), "hex").toString("base64url").slice(0, 16);
  const passwordHash = await hashPassword(temporaryPassword);

  const created = await db.transaction(async (tx) => {
    const userId = randomUUID();

    if (body.workspaceMode === "EXISTING") {
      const [defaultWorkspaceId] = ids;
      if (!defaultWorkspaceId) throw validation("Pilih minimal satu workspace untuk akun ini.");

      const [account] = await tx
        .insert(users)
        .values({
          id: userId,
          email,
          passwordHash,
          fullName,
          role: body.role,
          cmsAccess: body.role === "SUPERADMIN" ? true : body.cmsAccess,
          defaultWorkspaceId,
        })
        .returning();
      if (!account) throw conflict("Akun gagal dibuat.");

      await tx
        .insert(workspaceMemberships)
        .values(ids.map((workspaceId) => ({ workspaceId, userId: account.id, role: "MEMBER" as const })));

      return account;
    }

    const suffix = userId.replace(/-/g, "").slice(-4);
    const workspaceSlug = `${slugify(fullName)}-${suffix}`;

    const [workspace] = await tx
      .insert(workspaces)
      .values({ name: `${fullName} Workspace`, slug: workspaceSlug })
      .returning();
    if (!workspace) throw conflict("Workspace akun gagal dibuat.");

    const [account] = await tx
      .insert(users)
      .values({
        id: userId,
        email,
        passwordHash,
        fullName,
        role: body.role,
        cmsAccess: body.role === "SUPERADMIN" ? true : body.cmsAccess,
        defaultWorkspaceId: workspace.id,
      })
      .returning();
    if (!account) throw conflict("Akun gagal dibuat.");

    await tx
      .insert(workspaceMemberships)
      .values({ workspaceId: workspace.id, userId: account.id, role: "OWNER" });

    return account;
  });

  await queueMail({
    to: created.email,
    template: "ACCOUNT_CREATED",
    data: {
      fullName: created.fullName,
      email: created.email,
      password: temporaryPassword,
      loginUrl: `${env.PUBLIC_CREATOR_URL}/login`,
    },
  });

  await logAudit(db, {
    actorUserId: auth.user.id,
    action: "account.create",
    targetType: "user",
    targetId: created.id,
    metadata: { email: created.email, role: created.role, workspaceMode: body.workspaceMode },
    ip: clientIp(c),
  });

  return c.json({ account: toUser(created), temporaryPassword }, 201);
});

const patchAccountRoute = createRoute({
  method: "patch",
  path: "/accounts/{id}",
  tags: ["CMS accounts"],
  request: {
    params: accountParams,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            isActive: z.boolean().optional(),
            cmsAccess: z.boolean().optional(),
            defaultWorkspaceId: z.string().uuid().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Account updated", content: { "application/json": { schema: UserSchema } } },
    400: { description: "Invalid change", content: errorContent },
    404: { description: "Account not found", content: errorContent },
    409: { description: "Last superadmin", content: errorContent },
  },
});

cmsAccountRoutes.openapi(patchAccountRoute, async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

  const [account] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!account) throw notFound("Akun tidak ditemukan.");

  if (body.cmsAccess !== undefined && account.role === "SUPERADMIN") {
    throw validation("Superadmin selalu memiliki akses CMS.");
  }

  if (body.isActive === false && account.role === "SUPERADMIN") {
    const activeSupers = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, "SUPERADMIN"), eq(users.isActive, true)));
    if (activeSupers.length <= 1) throw conflict("Minimal satu Superadmin harus aktif.");
  }

  if (body.defaultWorkspaceId !== undefined) {
    const [membership] = await db
      .select({ id: workspaceMemberships.id })
      .from(workspaceMemberships)
      .where(
        and(
          eq(workspaceMemberships.userId, id),
          eq(workspaceMemberships.workspaceId, body.defaultWorkspaceId),
        ),
      )
      .limit(1);
    if (!membership) throw validation("Akun bukan anggota workspace tersebut.");
  }

  const [updated] = await db
    .update(users)
    .set({
      isActive: body.isActive ?? account.isActive,
      cmsAccess: body.cmsAccess ?? account.cmsAccess,
      defaultWorkspaceId: body.defaultWorkspaceId ?? account.defaultWorkspaceId,
    })
    .where(eq(users.id, id))
    .returning();
  if (!updated) throw notFound("Akun tidak ditemukan.");

  if (body.isActive === false) await destroyUserSessions(updated.id);

  return c.json(toUser(updated), 200);
});

const addAccountWorkspacesRoute = createRoute({
  method: "post",
  path: "/accounts/{id}/workspaces",
  tags: ["CMS accounts"],
  request: {
    params: accountParams,
    body: {
      content: {
        "application/json": {
          schema: z.object({ workspaceIds: z.array(z.string().uuid()).min(1) }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Every membership of the account",
      content: { "application/json": { schema: z.array(WorkspaceMembershipSchema) } },
    },
    400: { description: "Inactive workspace", content: errorContent },
    403: { description: "No CMS access", content: errorContent },
    404: { description: "Account or workspace not found", content: errorContent },
  },
});

cmsAccountRoutes.openapi(addAccountWorkspacesRoute, async (c) => {
  const { id } = c.req.valid("param");
  const ids = [...new Set(c.req.valid("json").workspaceIds)];

  const [account] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!account) throw notFound("Akun tidak ditemukan.");

  await assertActiveWorkspaces(ids);

  await db
    .insert(workspaceMemberships)
    .values(ids.map((workspaceId) => ({ workspaceId, userId: id, role: "MEMBER" as const })))
    .onConflictDoNothing({
      target: [workspaceMemberships.workspaceId, workspaceMemberships.userId],
    });

  const [defaultWorkspaceId] = ids;
  if (account.defaultWorkspaceId === null && defaultWorkspaceId) {
    await db.update(users).set({ defaultWorkspaceId }).where(eq(users.id, id));
  }

  const rows = await db
    .select()
    .from(workspaceMemberships)
    .where(eq(workspaceMemberships.userId, id))
    .orderBy(workspaceMemberships.joinedAt);

  return c.json(rows.map(toMembership), 200);
});

const removeAccountWorkspaceRoute = createRoute({
  method: "delete",
  path: "/accounts/{id}/workspaces/{workspaceId}",
  tags: ["CMS accounts"],
  request: { params: accountWorkspaceParams },
  responses: {
    204: { description: "Membership removed" },
    403: { description: "No CMS access", content: errorContent },
    404: { description: "Account is not a member", content: errorContent },
    409: { description: "Account would be stranded", content: errorContent },
  },
});

cmsAccountRoutes.openapi(removeAccountWorkspaceRoute, async (c) => {
  const { id, workspaceId } = c.req.valid("param");

  const [membership] = await db
    .select()
    .from(workspaceMemberships)
    .where(
      and(eq(workspaceMemberships.userId, id), eq(workspaceMemberships.workspaceId, workspaceId)),
    )
    .limit(1);
  if (!membership) throw notFound("Akun bukan anggota workspace tersebut.");

  if ((await membershipCount(db, id)) <= 1) {
    throw conflict("Setiap akun harus punya minimal satu workspace.");
  }

  await db.transaction(async (tx) => {
    await tx.delete(workspaceMemberships).where(eq(workspaceMemberships.id, membership.id));
    await relocateDefaultWorkspace(tx, id, workspaceId);
  });

  return c.body(null, 204);
});

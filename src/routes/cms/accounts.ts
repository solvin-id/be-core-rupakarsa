import { randomUUID } from "node:crypto";

import { and, desc, eq } from "drizzle-orm";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { requireCms, sessionGuard } from "../../auth/middleware.js";
import { hashPassword } from "../../auth/password.js";
import { destroyUserSessions } from "../../auth/session.js";
import { db } from "../../db/client.js";
import { users, workspaceMemberships, workspaces } from "../../db/schema.js";
import { conflict, notFound, validation } from "../../http/errors.js";
import { defaultHook } from "../../http/route-helpers.js";
import { toUser } from "../../http/serialize.js";
import {
  AccountCreatedSchema,
  ErrorResponseSchema,
  RoleSchema,
  UserSchema,
} from "../../http/schemas.js";
import type { AppBindings } from "../../http/types.js";
import { slugify } from "../../services/slug.js";

export const cmsAccountRoutes = new OpenAPIHono<AppBindings>({ defaultHook });

const errorContent = { "application/json": { schema: ErrorResponseSchema } };
const accountParams = z.object({ id: z.string().uuid() });

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
  const body = c.req.valid("json");
  const fullName = body.fullName.trim();
  if (fullName.length < 2) throw validation("Nama akun minimal 2 karakter.");

  const email = body.email.trim().toLowerCase();
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing) throw conflict("Email sudah terdaftar.");

  const temporaryPassword = Buffer.from(randomUUID().replace(/-/g, ""), "hex")
    .toString("base64url")
    .slice(0, 16);
  const passwordHash = await hashPassword(temporaryPassword);

  const created = await db.transaction(async (tx) => {
    const userId = randomUUID();
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

  const [updated] = await db
    .update(users)
    .set({
      isActive: body.isActive ?? account.isActive,
      cmsAccess: body.cmsAccess ?? account.cmsAccess,
    })
    .where(eq(users.id, id))
    .returning();
  if (!updated) throw notFound("Akun tidak ditemukan.");

  if (body.isActive === false) await destroyUserSessions(updated.id);

  return c.json(toUser(updated), 200);
});

import { eq } from "drizzle-orm";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { requireCms, sessionGuard } from "../../auth/middleware.js";
import { db } from "../../db/client.js";
import { tokenLedger, users, workspaceMemberships, workspaces } from "../../db/schema.js";
import { conflict, notFound, validation } from "../../http/errors.js";
import { defaultHook } from "../../http/route-helpers.js";
import { toMemberSummary, toWorkspace } from "../../http/serialize.js";
import {
  AdminWorkspacesSchema,
  ErrorResponseSchema,
  WorkspaceSchema,
} from "../../http/schemas.js";
import type { AppBindings } from "../../http/types.js";
import { slugify } from "../../services/slug.js";
import { topUpWorkspace } from "../../services/token-service.js";
import { takenSlugs, uniqueSlug } from "../../services/workspace-service.js";

export const cmsWorkspaceRoutes = new OpenAPIHono<AppBindings>({ defaultHook });

const errorContent = { "application/json": { schema: ErrorResponseSchema } };
const workspaceParams = z.object({ id: z.string().uuid() });

cmsWorkspaceRoutes.use("/workspaces", sessionGuard(), requireCms());
cmsWorkspaceRoutes.use("/workspaces/*", sessionGuard(), requireCms());

const listRoute = createRoute({
  method: "get",
  path: "/workspaces",
  tags: ["CMS workspaces"],
  responses: {
    200: {
      description: "All workspaces with memberships",
      content: { "application/json": { schema: AdminWorkspacesSchema } },
    },
  },
});

cmsWorkspaceRoutes.openapi(listRoute, async (c) => {
  const workspaceRows = await db.select().from(workspaces).orderBy(workspaces.createdAt);
  const membershipRows = await db
    .select({ membership: workspaceMemberships, user: users })
    .from(workspaceMemberships)
    .innerJoin(users, eq(users.id, workspaceMemberships.userId))
    .orderBy(workspaceMemberships.joinedAt);

  return c.json(
    {
      workspaces: workspaceRows.map(toWorkspace),
      memberships: membershipRows.map((row) => toMemberSummary(row.membership, row.user)),
    },
    200,
  );
});

const createRoute_ = createRoute({
  method: "post",
  path: "/workspaces",
  tags: ["CMS workspaces"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string(),
            slug: z.string(),
            ownerId: z.string().uuid(),
            tokenBalance: z.number().int().min(0).optional(),
            freePlanRemaining: z.number().int().min(0).optional(),
            isActive: z.boolean().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: { description: "Workspace created", content: { "application/json": { schema: WorkspaceSchema } } },
    400: { description: "Invalid name or slug", content: errorContent },
    404: { description: "Owner not found", content: errorContent },
    409: { description: "Slug already used", content: errorContent },
  },
});

cmsWorkspaceRoutes.openapi(createRoute_, async (c) => {
  const auth = c.get("auth");
  const body = c.req.valid("json");

  const name = body.name.trim();
  if (name.length < 2) throw validation("Nama workspace minimal 2 karakter.");

  const [owner] = await db.select({ id: users.id }).from(users).where(eq(users.id, body.ownerId)).limit(1);
  if (!owner) throw notFound("Akun owner tidak ditemukan.");

  const explicitSlug = body.slug.trim().length > 0;
  const base = slugify(explicitSlug ? body.slug : name);
  if (base.length < 2) throw validation("Slug workspace minimal 2 karakter.");

  const taken = await takenSlugs(db);
  if (explicitSlug && taken.has(base)) throw conflict("Slug workspace sudah dipakai.");
  const slug = explicitSlug ? base : uniqueSlug(base, taken);

  const tokenBalance = body.tokenBalance ?? 0;
  const freePlanRemaining = body.freePlanRemaining ?? 0;

  const created = await db.transaction(async (tx) => {
    const [workspace] = await tx
      .insert(workspaces)
      .values({
        name,
        slug,
        tokenBalance,
        freePlanRemaining,
        isActive: body.isActive ?? true,
      })
      .returning();
    if (!workspace) throw conflict("Workspace gagal dibuat.");

    await tx
      .insert(workspaceMemberships)
      .values({ workspaceId: workspace.id, userId: owner.id, role: "OWNER" });

    if (tokenBalance > 0) {
      await tx.insert(tokenLedger).values({
        workspaceId: workspace.id,
        userId: auth.user.id,
        txType: "TOPUP",
        amount: tokenBalance,
        balanceAfter: tokenBalance,
        notes: freePlanRemaining > 0 ? `plan:+${freePlanRemaining}` : "saldo awal",
      });
    }

    return workspace;
  });

  return c.json(toWorkspace(created), 201);
});

const patchRoute = createRoute({
  method: "patch",
  path: "/workspaces/{id}",
  tags: ["CMS workspaces"],
  request: {
    params: workspaceParams,
    body: {
      content: {
        "application/json": {
          schema: z.object({ name: z.string().optional(), isActive: z.boolean().optional() }),
        },
      },
    },
  },
  responses: {
    200: { description: "Workspace updated", content: { "application/json": { schema: WorkspaceSchema } } },
    400: { description: "Invalid name", content: errorContent },
    404: { description: "Workspace not found", content: errorContent },
  },
});

cmsWorkspaceRoutes.openapi(patchRoute, async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

  const patch: { name?: string; isActive?: boolean } = {};
  if (body.name !== undefined) {
    const name = body.name.trim();
    if (name.length < 2) throw validation("Nama workspace minimal 2 karakter.");
    patch.name = name;
  }
  if (body.isActive !== undefined) patch.isActive = body.isActive;

  const [updated] = await db.update(workspaces).set(patch).where(eq(workspaces.id, id)).returning();
  if (!updated) throw notFound("Workspace tidak ditemukan.");

  return c.json(toWorkspace(updated), 200);
});

const topupRoute = createRoute({
  method: "post",
  path: "/workspaces/{id}/topup",
  tags: ["CMS workspaces"],
  request: {
    params: workspaceParams,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            tokens: z.number().int(),
            plan: z.number().int().min(0).default(0),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Workspace topped up", content: { "application/json": { schema: WorkspaceSchema } } },
    400: { description: "Invalid amount", content: errorContent },
    404: { description: "Workspace not found", content: errorContent },
  },
});

cmsWorkspaceRoutes.openapi(topupRoute, async (c) => {
  const auth = c.get("auth");
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

  if (body.tokens < 1) throw validation("Jumlah token harus lebih dari 0.");

  const updated = await db.transaction((tx) =>
    topUpWorkspace(tx, {
      workspaceId: id,
      actorId: auth.user.id,
      tokens: body.tokens,
      plan: body.plan,
    }),
  );

  return c.json(toWorkspace(updated), 200);
});

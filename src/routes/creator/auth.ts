import { eq } from "drizzle-orm";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { sessionGuard } from "../../auth/middleware.js";
import { hashPassword, verifyPassword } from "../../auth/password.js";
import {
  clearSessionCookie,
  createSession,
  destroySession,
  destroyUserSessions,
  writeSessionCookie,
} from "../../auth/session.js";
import { db } from "../../db/client.js";
import { users } from "../../db/schema.js";
import { AppError, unauthorized, validation } from "../../http/errors.js";
import { loginLimiter } from "../../http/rate-limit.js";
import { defaultHook } from "../../http/route-helpers.js";
import {
  ErrorResponseSchema,
  SessionPayloadSchema,
} from "../../http/schemas.js";
import type { AppBindings } from "../../http/types.js";
import { resolveSession } from "../../services/workspace-service.js";
import { loadMemberships } from "../../services/workspace-service.js";

const NO_WORKSPACE_MESSAGE = "Akun ini belum memiliki workspace. Hubungi Superadmin Rupakarsa.";

export const creatorAuthRoutes = new OpenAPIHono<AppBindings>({ defaultHook });

const loginRoute = createRoute({
  method: "post",
  path: "/auth/login",
  tags: ["Creator auth"],
  middleware: [loginLimiter()] as const,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            email: z.string().min(1, "Email wajib diisi."),
            password: z.string().min(1, "Password wajib diisi."),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Session payload",
      content: { "application/json": { schema: SessionPayloadSchema } },
    },
    401: {
      description: "Invalid credentials or inactive account",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    403: {
      description: "Account without any workspace",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

creatorAuthRoutes.openapi(loginRoute, async (c) => {
  const body = c.req.valid("json");
  const email = body.email.trim().toLowerCase();

  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user) throw unauthorized("Akun tidak ditemukan atau password salah.");

  const matches = await verifyPassword(body.password, user.passwordHash);
  if (!matches) throw unauthorized("Akun tidak ditemukan atau password salah.");
  if (!user.isActive) throw unauthorized("Akun ini sedang tidak aktif. Hubungi Superadmin.");

  const rows = await loadMemberships(db, user.id);
  if (rows.length === 0) throw new AppError(403, "FORBIDDEN", NO_WORKSPACE_MESSAGE);

  const preferred =
    rows.find((row) => row.workspace.id === user.defaultWorkspaceId) ??
    rows.find((row) => row.workspace.isActive) ??
    rows[0];
  if (!preferred) throw new AppError(403, "FORBIDDEN", NO_WORKSPACE_MESSAGE);

  const { session, token } = await createSession(user.id, preferred.workspace.id);
  writeSessionCookie(c, token);

  const resolved = await resolveSession(user, session.id, preferred.workspace.id);
  return c.json(resolved.payload, 200);
});

const logoutRoute = createRoute({
  method: "post",
  path: "/auth/logout",
  tags: ["Creator auth"],
  middleware: [sessionGuard()] as const,
  responses: {
    204: { description: "Session destroyed" },
    401: {
      description: "No session",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

creatorAuthRoutes.openapi(logoutRoute, async (c) => {
  const auth = c.get("auth");
  await destroySession(auth.sessionId);
  clearSessionCookie(c);
  return c.body(null, 204);
});

const passwordRoute = createRoute({
  method: "post",
  path: "/auth/password",
  tags: ["Creator auth"],
  middleware: [sessionGuard()] as const,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            currentPassword: z.string().min(1, "Password saat ini wajib diisi."),
            newPassword: z.string().min(1, "Password baru wajib diisi."),
          }),
        },
      },
    },
  },
  responses: {
    204: { description: "Password updated" },
    400: {
      description: "Invalid new password",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Wrong current password",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

creatorAuthRoutes.openapi(passwordRoute, async (c) => {
  const auth = c.get("auth");
  const body = c.req.valid("json");

  const matches = await verifyPassword(body.currentPassword, auth.user.passwordHash);
  if (!matches) throw unauthorized("Password saat ini salah.");
  if (body.newPassword.length < 8) throw validation("Password baru minimal 8 karakter.");

  const passwordHash = await hashPassword(body.newPassword);
  await db.update(users).set({ passwordHash }).where(eq(users.id, auth.user.id));
  await destroyUserSessions(auth.user.id, auth.sessionId);

  return c.body(null, 204);
});

const sessionRoute = createRoute({
  method: "get",
  path: "/session",
  tags: ["Creator auth"],
  middleware: [sessionGuard()] as const,
  responses: {
    200: {
      description: "Current session",
      content: { "application/json": { schema: SessionPayloadSchema } },
    },
    401: {
      description: "No session",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    403: {
      description: "No workspace membership",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

creatorAuthRoutes.openapi(sessionRoute, async (c) => {
  const auth = c.get("auth");
  const resolved = await resolveSession(auth.user, auth.sessionId, auth.workspaceId);
  return c.json(resolved.payload, 200);
});

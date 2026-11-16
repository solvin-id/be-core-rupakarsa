import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { clientIp } from "../../http/middleware.js";
import { passwordResetLimiter } from "../../http/rate-limit.js";
import { defaultHook } from "../../http/route-helpers.js";
import { ErrorResponseSchema } from "../../http/schemas.js";
import type { AppBindings } from "../../http/types.js";
import { consumePasswordReset, requestPasswordReset } from "../../services/password-reset-service.js";

export const creatorPasswordResetRoutes = new OpenAPIHono<AppBindings>({ defaultHook });

const errorContent = { "application/json": { schema: ErrorResponseSchema } };

const requestRoute = createRoute({
  method: "post",
  path: "/auth/password-reset/request",
  tags: ["Creator auth"],
  middleware: [passwordResetLimiter()] as const,
  request: {
    body: {
      content: {
        "application/json": { schema: z.object({ email: z.string().min(1, "Email wajib diisi.") }) },
      },
    },
  },
  responses: {
    200: {
      description: "Always accepted; never reveals whether the account exists",
      content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
    },
  },
});

creatorPasswordResetRoutes.openapi(requestRoute, async (c) => {
  const body = c.req.valid("json");
  await requestPasswordReset(body.email, clientIp(c));
  return c.json({ ok: true }, 200);
});

const confirmRoute = createRoute({
  method: "post",
  path: "/auth/password-reset/confirm",
  tags: ["Creator auth"],
  middleware: [passwordResetLimiter()] as const,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ token: z.string().min(1), newPassword: z.string().min(1) }),
        },
      },
    },
  },
  responses: {
    204: { description: "Password replaced" },
    400: { description: "Expired or used token, or weak password", content: errorContent },
  },
});

creatorPasswordResetRoutes.openapi(confirmRoute, async (c) => {
  const body = c.req.valid("json");
  await consumePasswordReset(body.token, body.newPassword);
  return c.body(null, 204);
});

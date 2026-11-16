import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { requireCms, sessionGuard } from "../../auth/middleware.js";
import { decryptSecret, encryptSecret, maskSecret } from "../../crypto/encryption.js";
import { db } from "../../db/client.js";
import { clientIp } from "../../http/middleware.js";
import { defaultHook } from "../../http/route-helpers.js";
import {
  ErrorResponseSchema,
  MailSettingsSchema,
  ProviderTestSchema,
} from "../../http/schemas.js";
import type { AppBindings } from "../../http/types.js";
import { logAudit } from "../../services/audit-service.js";
import { queueMail } from "../../services/mail-service.js";
import {
  DEFAULT_MAIL,
  SETTING_KEYS,
  getMailSettings,
  writeSetting,
} from "../../services/settings.js";

export const cmsMailRoutes = new OpenAPIHono<AppBindings>({ defaultHook });

const errorContent = { "application/json": { schema: ErrorResponseSchema } };

cmsMailRoutes.use("/settings/mail", sessionGuard(), requireCms());
cmsMailRoutes.use("/settings/mail/*", sessionGuard(), requireCms());

const getRoute = createRoute({
  method: "get",
  path: "/settings/mail",
  tags: ["CMS settings"],
  responses: {
    200: { description: "Mail settings", content: { "application/json": { schema: MailSettingsSchema } } },
  },
});

cmsMailRoutes.openapi(getRoute, async (c) => {
  const settings = await getMailSettings(db);
  return c.json(
    {
      driver: settings.driver,
      fromName: settings.fromName,
      fromEmail: settings.fromEmail,
      smtp: {
        host: settings.smtp.host,
        port: settings.smtp.port,
        secure: settings.smtp.secure,
        user: settings.smtp.user,
        passwordMasked:
          settings.smtp.passwordEncrypted.length > 0
            ? maskSecret(decryptSecret(settings.smtp.passwordEncrypted))
            : "",
      },
    },
    200,
  );
});

const putRoute = createRoute({
  method: "put",
  path: "/settings/mail",
  tags: ["CMS settings"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            driver: z.enum(["smtp", "log"]),
            fromName: z.string(),
            fromEmail: z.string(),
            smtp: z.object({
              host: z.string(),
              port: z.number().int().min(1).max(65535),
              secure: z.boolean(),
              user: z.string(),
              password: z.string().optional(),
            }),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Mail settings saved", content: { "application/json": { schema: MailSettingsSchema } } },
    400: { description: "Invalid settings", content: errorContent },
  },
});

cmsMailRoutes.openapi(putRoute, async (c) => {
  const auth = c.get("auth");
  const body = c.req.valid("json");
  const existing = await getMailSettings(db);

  const nextPassword =
    body.smtp.password && body.smtp.password.trim().length > 0
      ? encryptSecret(body.smtp.password.trim())
      : existing.smtp.passwordEncrypted;

  await writeSetting(db, SETTING_KEYS.mail, {
    ...DEFAULT_MAIL,
    driver: body.driver,
    fromName: body.fromName.trim() || DEFAULT_MAIL.fromName,
    fromEmail: body.fromEmail.trim() || DEFAULT_MAIL.fromEmail,
    smtp: {
      host: body.smtp.host.trim(),
      port: body.smtp.port,
      secure: body.smtp.secure,
      user: body.smtp.user.trim(),
      passwordEncrypted: nextPassword,
    },
  });

  await logAudit(db, {
    actorUserId: auth.user.id,
    action: "settings.mail.update",
    targetType: "app_settings",
    targetId: SETTING_KEYS.mail,
    metadata: { driver: body.driver, host: body.smtp.host.trim() },
    ip: clientIp(c),
  });

  return c.json(
    {
      driver: body.driver,
      fromName: body.fromName.trim() || DEFAULT_MAIL.fromName,
      fromEmail: body.fromEmail.trim() || DEFAULT_MAIL.fromEmail,
      smtp: {
        host: body.smtp.host.trim(),
        port: body.smtp.port,
        secure: body.smtp.secure,
        user: body.smtp.user.trim(),
        passwordMasked: nextPassword.length > 0 ? maskSecret(decryptSecret(nextPassword)) : "",
      },
    },
    200,
  );
});

const testRoute = createRoute({
  method: "post",
  path: "/settings/mail/test",
  tags: ["CMS settings"],
  request: {
    body: { content: { "application/json": { schema: z.object({ to: z.string() }) } } },
  },
  responses: {
    200: { description: "Test mail result", content: { "application/json": { schema: ProviderTestSchema } } },
  },
});

cmsMailRoutes.openapi(testRoute, async (c) => {
  const auth = c.get("auth");
  const { to } = c.req.valid("json");
  const email = to.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ ok: false, message: "Format email tujuan tidak valid." }, 200);
  }

  const settings = await getMailSettings(db);
  try {
    await queueMail({
      to: email,
      template: "ACCOUNT_CREATED",
      data: {
        fullName: auth.user.fullName,
        email: auth.user.email,
        password: "(email uji dari CMS)",
        loginUrl: "https://rupakarsa.solvin.id/login",
      },
    });
    return c.json(
      {
        ok: true,
        message:
          settings.driver === "log"
            ? "Email uji tercatat di outbox (driver log)."
            : "Email uji dikirim.",
      },
      200,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Email uji gagal dikirim.";
    return c.json({ ok: false, message }, 200);
  }
});

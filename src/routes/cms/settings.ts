import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { requireCms, sessionGuard } from "../../auth/middleware.js";
import { db } from "../../db/client.js";
import { validation } from "../../http/errors.js";
import { defaultHook } from "../../http/route-helpers.js";
import { AdminContactSchema, ErrorResponseSchema } from "../../http/schemas.js";
import type { AppBindings } from "../../http/types.js";
import { SETTING_KEYS, getContact, writeSetting } from "../../services/settings.js";

export const cmsSettingsRoutes = new OpenAPIHono<AppBindings>({ defaultHook });

const errorContent = { "application/json": { schema: ErrorResponseSchema } };

cmsSettingsRoutes.use("/settings/contact", sessionGuard(), requireCms());

const getContactRoute = createRoute({
  method: "get",
  path: "/settings/contact",
  tags: ["CMS settings"],
  responses: {
    200: { description: "Admin contact", content: { "application/json": { schema: AdminContactSchema } } },
  },
});

cmsSettingsRoutes.openapi(getContactRoute, async (c) => {
  return c.json(await getContact(db), 200);
});

const putContactRoute = createRoute({
  method: "put",
  path: "/settings/contact",
  tags: ["CMS settings"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string(),
            whatsapp: z.string(),
            email: z.string(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Admin contact updated", content: { "application/json": { schema: AdminContactSchema } } },
    400: { description: "Invalid contact", content: errorContent },
  },
});

cmsSettingsRoutes.openapi(putContactRoute, async (c) => {
  const body = c.req.valid("json");

  const name = body.name.trim();
  if (name.length < 2) throw validation("Nama admin minimal 2 karakter.");

  const whatsapp = body.whatsapp.replace(/[^\d]/g, "");
  if (whatsapp.length < 8 || whatsapp.length > 15) {
    throw validation("Nomor WhatsApp harus 8–15 digit, contoh 6281234567890.");
  }

  const email = body.email.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw validation("Format email admin tidak valid.");
  }

  const contact = { name, whatsapp, email };
  await writeSetting(db, SETTING_KEYS.contact, contact);

  return c.json(contact, 200);
});

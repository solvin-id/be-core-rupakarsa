import { OpenAPIHono, createRoute } from "@hono/zod-openapi";

import { db } from "../../db/client.js";
import { env } from "../../env.js";
import { defaultHook } from "../../http/route-helpers.js";
import { PublicConfigSchema } from "../../http/schemas.js";
import type { AppBindings } from "../../http/types.js";
import { getContact, getPricing } from "../../services/settings.js";

export const publicRoutes = new OpenAPIHono<AppBindings>({ defaultHook });

const configRoute = createRoute({
  method: "get",
  path: "/api/public/config",
  tags: ["Public"],
  responses: {
    200: {
      description: "Public platform configuration",
      content: { "application/json": { schema: PublicConfigSchema } },
    },
  },
});

publicRoutes.openapi(configRoute, async (c) => {
  const [contact, pricing] = await Promise.all([getContact(db), getPricing(db)]);
  return c.json({ contact, pricing, features: { simulation: env.SIMULATION_MODE } }, 200);
});

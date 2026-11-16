import { sql } from "drizzle-orm";
import { OpenAPIHono, createRoute } from "@hono/zod-openapi";

import { db } from "../db/client.js";
import { defaultHook } from "../http/route-helpers.js";
import { HealthSchema } from "../http/schemas.js";
import type { AppBindings } from "../http/types.js";

export const healthRoutes = new OpenAPIHono<AppBindings>({ defaultHook });

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  tags: ["Infra"],
  responses: {
    200: {
      description: "Service health",
      content: { "application/json": { schema: HealthSchema } },
    },
  },
});

healthRoutes.openapi(healthRoute, async (c) => {
  let ok = true;
  try {
    await db.execute(sql`select 1`);
  } catch {
    ok = false;
  }
  return c.json({ status: "ok" as const, db: ok }, 200);
});

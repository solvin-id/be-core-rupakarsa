import { eq } from "drizzle-orm";
import { OpenAPIHono, createRoute } from "@hono/zod-openapi";

import { db } from "../../db/client.js";
import { aiModels } from "../../db/schema.js";
import { env } from "../../env.js";
import { defaultHook } from "../../http/route-helpers.js";
import { PublicConfigSchema } from "../../http/schemas.js";
import type { AppBindings } from "../../http/types.js";
import { getAiSettings, getContact, getPricing } from "../../services/settings.js";

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
  const [contact, pricing, ai] = await Promise.all([
    getContact(db),
    getPricing(db),
    getAiSettings(db),
  ]);

  const planModel = ai.planModelId
    ? (
        await db
          .select()
          .from(aiModels)
          .where(eq(aiModels.id, ai.planModelId))
          .limit(1)
      )[0] ?? null
    : null;

  return c.json(
    {
      contact,
      pricing,
      features: { simulation: env.SIMULATION_MODE },
      planModel: planModel
        ? {
            id: planModel.id,
            name: planModel.displayName,
            inputCapabilities: planModel.inputCapabilities,
          }
        : null,
      defaults: { videoModelId: ai.defaultVideoModelId },
    },
    200,
  );
});

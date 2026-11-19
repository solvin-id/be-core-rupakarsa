import { inArray } from "drizzle-orm";
import { OpenAPIHono, createRoute } from "@hono/zod-openapi";

import { db } from "../../db/client.js";
import { aiModels } from "../../db/schema.js";
import { env } from "../../env.js";
import { defaultHook } from "../../http/route-helpers.js";
import { PublicConfigSchema } from "../../http/schemas.js";
import type { AppBindings } from "../../http/types.js";
import { getAiSettings, getContact, getLimitsSettings, getPricing } from "../../services/settings.js";

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
  const [contact, pricing, ai, limits] = await Promise.all([
    getContact(db),
    getPricing(db),
    getAiSettings(db),
    getLimitsSettings(db),
  ]);

  // One lookup for every wired model: the studio gates each input on its own model, not on the
  // plan model (analysis and plan are independent services).
  const wiredIds = [ai.planModelId, ai.analysisModelId, ai.videoAnalysisModelId].filter(
    (id): id is string => Boolean(id),
  );
  const wiredRows = wiredIds.length
    ? await db.select().from(aiModels).where(inArray(aiModels.id, wiredIds))
    : [];
  const byId = new Map(wiredRows.map((row) => [row.id, row]));

  function modelRef(id: string | null) {
    const row = id ? byId.get(id) : undefined;
    return row
      ? {
          id: row.id,
          name: row.displayName,
          inputCapabilities: row.inputCapabilities,
        }
      : null;
  }

  return c.json(
    {
      contact,
      pricing,
      features: { simulation: env.SIMULATION_MODE },
      planModel: modelRef(ai.planModelId),
      analysisModels: {
        image: modelRef(ai.analysisModelId),
        video: modelRef(ai.videoAnalysisModelId),
      },
      defaults: { videoModelId: ai.defaultVideoModelId },
      limits: {
        planPromptMaxChars: limits.planPromptMaxChars,
        finalPromptMaxChars: limits.finalPromptMaxChars,
        maxSceneChainScenes: limits.maxSceneChainScenes,
      },
    },
    200,
  );
});

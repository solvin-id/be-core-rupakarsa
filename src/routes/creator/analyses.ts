import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { requireWorkspace, sessionGuard } from "../../auth/middleware.js";
import { notFound } from "../../http/errors.js";
import { defaultHook } from "../../http/route-helpers.js";
import { AssetAnalysisSchema, ErrorResponseSchema } from "../../http/schemas.js";
import type { AppBindings } from "../../http/types.js";
import { analyzeAsset } from "../../services/analysis-service.js";

export const creatorAnalysisRoutes = new OpenAPIHono<AppBindings>({ defaultHook });

const errorContent = { "application/json": { schema: ErrorResponseSchema } };

creatorAnalysisRoutes.use("/analyses", sessionGuard(), requireWorkspace("MEMBER"));
creatorAnalysisRoutes.use("/analyses/*", sessionGuard(), requireWorkspace("MEMBER"));

const analyzeRoute = createRoute({
  method: "post",
  path: "/analyses",
  tags: ["Creator analyses"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            mediaAssetId: z.string().uuid().optional(),
            generationId: z.string().uuid().optional(),
            refresh: z.boolean().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Cached or fresh media analysis", content: { "application/json": { schema: AssetAnalysisSchema } } },
    400: { description: "Invalid source", content: errorContent },
    404: { description: "Asset not found", content: errorContent },
    409: { description: "Analysis model not configured", content: errorContent },
  },
});

creatorAnalysisRoutes.openapi(analyzeRoute, async (c) => {
  const auth = c.get("auth");
  const workspaceId = auth.workspaceId;
  if (!workspaceId) throw notFound("Workspace aktif tidak ditemukan.");
  const body = c.req.valid("json");

  const analysis = await analyzeAsset(
    workspaceId,
    { mediaAssetId: body.mediaAssetId, generationId: body.generationId },
    { refresh: body.refresh === true },
  );
  return c.json(analysis, 200);
});

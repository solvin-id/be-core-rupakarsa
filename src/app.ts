import { OpenAPIHono } from "@hono/zod-openapi";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { errorResponse } from "./http/error-handler.js";
import {
  corsMiddleware,
  jsonBodyLimit,
  originGuard,
  requestId,
  requestLogger,
  secureHeaders,
} from "./http/middleware.js";
import { defaultHook } from "./http/route-helpers.js";
import type { ErrorBody } from "./http/types.js";
import type { AppBindings } from "./http/types.js";
import { cmsAccountRoutes } from "./routes/cms/accounts.js";
import { cmsModelRoutes } from "./routes/cms/models.js";
import { cmsProviderRoutes } from "./routes/cms/providers.js";
import { cmsSettingsRoutes } from "./routes/cms/settings.js";
import { cmsWorkspaceRoutes } from "./routes/cms/workspaces.js";
import { creatorAuthRoutes } from "./routes/creator/auth.js";
import { creatorFolderRoutes } from "./routes/creator/folders.js";
import { creatorGenerationRoutes } from "./routes/creator/generations.js";
import { creatorUploadRoutes } from "./routes/creator/uploads.js";
import { creatorWorkspaceRoutes } from "./routes/creator/workspaces.js";
import { healthRoutes } from "./routes/health.js";
import { mediaRoutes } from "./routes/media.js";
import { publicRoutes } from "./routes/public/config.js";

export function createApp(): OpenAPIHono<AppBindings> {
  const app = new OpenAPIHono<AppBindings>({ defaultHook });

  app.use("*", requestId());
  app.use("*", requestLogger());
  app.use("*", secureHeaders());
  app.use("*", corsMiddleware());
  app.use("*", originGuard());

  // Uploads own their larger limit; every other API route caps JSON bodies at 1 MB.
  app.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/creator/uploads" || c.req.path === "/openapi.json") {
      await next();
      return;
    }
    return jsonBodyLimit(c, next);
  });

  app.route("/", mediaRoutes);
  app.route("/", healthRoutes);
  app.route("/", publicRoutes);

  app.route("/api/creator", creatorAuthRoutes);
  app.route("/api/creator", creatorWorkspaceRoutes);
  app.route("/api/creator", creatorFolderRoutes);
  app.route("/api/creator", creatorGenerationRoutes);
  app.route("/api/creator", creatorUploadRoutes);

  app.route("/api/cms", cmsAccountRoutes);
  app.route("/api/cms", cmsWorkspaceRoutes);
  app.route("/api/cms", cmsProviderRoutes);
  app.route("/api/cms", cmsModelRoutes);
  app.route("/api/cms", cmsSettingsRoutes);

  app.onError((error, c) => {
    const { status, body } = errorResponse(error, c.get("requestId"));
    return c.json<ErrorBody>(body, status as ContentfulStatusCode);
  });

  app.notFound((c) => c.json<ErrorBody>({ error: { code: "NOT_FOUND", message: "Rute tidak ditemukan." } }, 404));

  return app;
}

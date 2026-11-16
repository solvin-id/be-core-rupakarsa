import { OpenAPIHono } from "@hono/zod-openapi";

import { env } from "../../env.js";
import { logger } from "../../logger.js";
import { completeDriveConnect } from "../../services/workspace-drive-service.js";
import type { AppBindings } from "../../http/types.js";

export const publicGDriveRoutes = new OpenAPIHono<AppBindings>();

const WORKSPACES_PATH = "/app/workspaces";

function bounce(status: "connected" | "error"): string {
  return `${env.PUBLIC_CREATOR_URL.replace(/\/$/, "")}${WORKSPACES_PATH}?drive=${status}`;
}

/**
 * Google redirects the browser here after consent. No session cookie is involved: the single-use
 * `state` nonce stored when the flow started is the CSRF token, so failures are surfaced on the
 * Creator page instead of as an API error.
 */
publicGDriveRoutes.get("/api/public/google/oauth/callback", async (c) => {
  const state = c.req.query("state") ?? "";
  const code = c.req.query("code") ?? null;
  const error = c.req.query("error") ?? null;

  if (state.length === 0) {
    logger.warn({ event: "gdrive.oauth.callback" }, "consent callback without state");
    return c.redirect(bounce("error"), 302);
  }

  try {
    await completeDriveConnect(state, code, error);
    return c.redirect(bounce("connected"), 302);
  } catch (failure) {
    logger.warn({ err: failure, event: "gdrive.oauth.callback" }, "consent callback rejected");
    return c.redirect(bounce("error"), 302);
  }
});

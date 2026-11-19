import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { requireCms, sessionGuard } from "../../auth/middleware.js";
import type { AiCharacterReferenceRow } from "../../db/schema.js";
import { defaultHook } from "../../http/route-helpers.js";
import { AiCharacterReferenceSchema } from "../../http/schemas.js";
import type { AppBindings } from "../../http/types.js";
import { listCharacters } from "../../services/higgsfield-character-service.js";

export const cmsCharacterRoutes = new OpenAPIHono<AppBindings>({ defaultHook });

cmsCharacterRoutes.use("/higgsfield/characters", sessionGuard(), requireCms());

/**
 * `ai_character_references.status` is already the mapped enum, but the row type is `text`; the
 * serializer narrows it so the DTO schema can stay honest about the five provider states.
 */
function toCharacter(row: AiCharacterReferenceRow) {
  return AiCharacterReferenceSchema.parse({
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  });
}

const listRoute = createRoute({
  method: "get",
  path: "/higgsfield/characters",
  tags: ["CMS Higgsfield"],
  responses: {
    200: {
      description: "Soul ID references, newest first",
      content: { "application/json": { schema: z.array(AiCharacterReferenceSchema) } },
    },
  },
});

/** Read-only: training and selection live on the project's Pre-context panel. */
cmsCharacterRoutes.openapi(listRoute, async (c) => {
  const rows = await listCharacters();
  return c.json(rows.map(toCharacter), 200);
});

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { eq } from "drizzle-orm";

import { requireCms, sessionGuard } from "../../auth/middleware.js";
import { db } from "../../db/client.js";
import { aiModels } from "../../db/schema.js";
import { validation } from "../../http/errors.js";
import { clientIp } from "../../http/middleware.js";
import { defaultHook } from "../../http/route-helpers.js";
import { AdminContactSchema, ErrorResponseSchema, LimitsSettingsSchema } from "../../http/schemas.js";
import type { AppBindings } from "../../http/types.js";
import { logAudit } from "../../services/audit-service.js";
import {
  SETTING_KEYS,
  getAiSettings,
  getContact,
  getLimitsSettings,
  writeSetting,
} from "../../services/settings.js";

export const cmsSettingsRoutes = new OpenAPIHono<AppBindings>({ defaultHook });

const errorContent = { "application/json": { schema: ErrorResponseSchema } };

cmsSettingsRoutes.use("/settings/contact", sessionGuard(), requireCms());
cmsSettingsRoutes.use("/settings/ai", sessionGuard(), requireCms());
cmsSettingsRoutes.use("/settings/limits", sessionGuard(), requireCms());

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
  const auth = c.get("auth");
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

  await logAudit(db, {
    actorUserId: auth.user.id,
    action: "settings.contact.update",
    targetType: "app_settings",
    targetId: SETTING_KEYS.contact,
    metadata: { email },
    ip: clientIp(c),
  });

  return c.json(contact, 200);
});

const getAiRoute = createRoute({
  method: "get",
  path: "/settings/ai",
  tags: ["CMS settings"],
  responses: {
    200: {
      description: "AI model wiring",
      content: {
        "application/json": {
          schema: z.object({
            planModelId: z.string().nullable(),
            analysisModelId: z.string().nullable(),
            videoAnalysisModelId: z.string().nullable(),
            defaultVideoModelId: z.string().nullable(),
          }),
        },
      },
    },
  },
});

cmsSettingsRoutes.openapi(getAiRoute, async (c) => {
  return c.json(await getAiSettings(db), 200);
});

interface CapabilityRequirement {
  field: "planModelId" | "analysisModelId" | "videoAnalysisModelId" | "defaultVideoModelId";
  capability: "TEXT" | "IMAGE" | "VIDEO";
  direction: "in" | "out";
  message: string;
}

const AI_REQUIREMENTS: CapabilityRequirement[] = [
  {
    field: "planModelId",
    capability: "TEXT",
    direction: "out",
    message: "Model plan harus menghasilkan teks.",
  },
  {
    field: "analysisModelId",
    capability: "IMAGE",
    direction: "in",
    message: "Model analisis gambar harus menerima input gambar.",
  },
  {
    field: "videoAnalysisModelId",
    capability: "VIDEO",
    direction: "in",
    message: "Model analisis video harus menerima input video.",
  },
  {
    field: "defaultVideoModelId",
    capability: "VIDEO",
    direction: "out",
    message: "Default model video harus menghasilkan video.",
  },
];

const putAiRoute = createRoute({
  method: "put",
  path: "/settings/ai",
  tags: ["CMS settings"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            planModelId: z.string().uuid().nullable(),
            analysisModelId: z.string().uuid().nullable(),
            videoAnalysisModelId: z.string().uuid().nullable(),
            defaultVideoModelId: z.string().uuid().nullable(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "AI model wiring saved",
      content: {
        "application/json": {
          schema: z.object({
            planModelId: z.string().nullable(),
            analysisModelId: z.string().nullable(),
            videoAnalysisModelId: z.string().nullable(),
            defaultVideoModelId: z.string().nullable(),
          }),
        },
      },
    },
    400: { description: "Invalid model or capability", content: errorContent },
  },
});

cmsSettingsRoutes.openapi(putAiRoute, async (c) => {
  const auth = c.get("auth");
  const body = c.req.valid("json");

  for (const requirement of AI_REQUIREMENTS) {
    const modelId = body[requirement.field];
    if (!modelId) continue;
    const [model] = await db.select().from(aiModels).where(eq(aiModels.id, modelId)).limit(1);
    if (!model) throw validation("Model yang dipilih tidak ditemukan.");
    const capabilities =
      requirement.direction === "in" ? model.inputCapabilities : model.outputCapabilities;
    if (!capabilities.includes(requirement.capability)) {
      throw validation(requirement.message);
    }
  }

  const settings = {
    planModelId: body.planModelId,
    analysisModelId: body.analysisModelId,
    videoAnalysisModelId: body.videoAnalysisModelId,
    defaultVideoModelId: body.defaultVideoModelId,
  };
  await writeSetting(db, SETTING_KEYS.ai, settings);

  await logAudit(db, {
    actorUserId: auth.user.id,
    action: "settings.ai.update",
    targetType: "app_settings",
    targetId: SETTING_KEYS.ai,
    metadata: settings,
    ip: clientIp(c),
  });

  return c.json(settings, 200);
});

const getLimitsRoute = createRoute({
  method: "get",
  path: "/settings/limits",
  tags: ["CMS settings"],
  responses: {
    200: {
      description: "Quota and prompt ceilings",
      content: { "application/json": { schema: LimitsSettingsSchema } },
    },
  },
});

cmsSettingsRoutes.openapi(getLimitsRoute, async (c) => {
  return c.json(await getLimitsSettings(db), 200);
});

const putLimitsRoute = createRoute({
  method: "put",
  path: "/settings/limits",
  tags: ["CMS settings"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            generationsPerDayPerWorkspace: z.number().int().min(1).max(1000),
            planRequestsPerHourPerUser: z.number().int().min(1).max(10000),
            planPromptMaxChars: z.number().int().min(200).max(20000),
            finalPromptMaxChars: z.number().int().min(200).max(32000),
            maxSceneChainScenes: z.number().int().min(1).max(10).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Limits saved",
      content: { "application/json": { schema: LimitsSettingsSchema } },
    },
    400: { description: "Invalid limits", content: errorContent },
  },
});

cmsSettingsRoutes.openapi(putLimitsRoute, async (c) => {
  const auth = c.get("auth");
  const body = c.req.valid("json");

  const settings = {
    generationsPerDayPerWorkspace: body.generationsPerDayPerWorkspace,
    planRequestsPerHourPerUser: body.planRequestsPerHourPerUser,
    planPromptMaxChars: body.planPromptMaxChars,
    finalPromptMaxChars: body.finalPromptMaxChars,
    maxSceneChainScenes: body.maxSceneChainScenes ?? (await getLimitsSettings(db)).maxSceneChainScenes,
  };
  await writeSetting(db, SETTING_KEYS.limits, settings);

  await logAudit(db, {
    actorUserId: auth.user.id,
    action: "settings.limits.update",
    targetType: "app_settings",
    targetId: SETTING_KEYS.limits,
    metadata: settings,
    ip: clientIp(c),
  });

  return c.json(settings, 200);
});

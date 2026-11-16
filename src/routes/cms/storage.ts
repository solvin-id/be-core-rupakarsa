import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { requireCms, sessionGuard } from "../../auth/middleware.js";
import { decryptSecret, encryptSecret, maskSecret } from "../../crypto/encryption.js";
import { db } from "../../db/client.js";
import { workspaceStorage, workspaces } from "../../db/schema.js";
import { env } from "../../env.js";
import { validation } from "../../http/errors.js";
import { clientIp } from "../../http/middleware.js";
import { defaultHook } from "../../http/route-helpers.js";
import {
  ErrorResponseSchema,
  ProviderTestSchema,
  StorageDriverSchema,
  StorageSettingsSchema,
  StorageUsageSchema,
} from "../../http/schemas.js";
import type { AppBindings } from "../../http/types.js";
import { logAudit } from "../../services/audit-service.js";
import {
  DEFAULT_STORAGE,
  SETTING_KEYS,
  getRawStorageSettings,
  writeSetting,
} from "../../services/settings.js";
import { buildS3DriverFromInput, clearStorageCache, storageUsage } from "../../services/storage-service.js";
import { LocalStorageDriver } from "../../storage/local-driver.js";

export const cmsStorageRoutes = new OpenAPIHono<AppBindings>({ defaultHook });

const errorContent = { "application/json": { schema: ErrorResponseSchema } };

cmsStorageRoutes.use("/settings/storage", sessionGuard(), requireCms());
cmsStorageRoutes.use("/settings/storage/*", sessionGuard(), requireCms());

const getRoute = createRoute({
  method: "get",
  path: "/settings/storage",
  tags: ["CMS storage"],
  responses: {
    200: { description: "Global storage settings", content: { "application/json": { schema: StorageSettingsSchema } } },
  },
});

cmsStorageRoutes.openapi(getRoute, async (c) => {
  const settings = await getRawStorageSettings(db);

  const workspaceRows = await db.select().from(workspaces).orderBy(workspaces.name);
  const driveRows = await db.select().from(workspaceStorage);
  const driveByWorkspace = new Map(driveRows.map((row) => [row.workspaceId, row]));

  return c.json(
    {
      driver: settings.driver,
      retentionDays: settings.retentionDays,
      s3: {
        endpoint: settings.s3.endpoint,
        region: settings.s3.region,
        bucket: settings.s3.bucket,
        accessKeyId: settings.s3.accessKeyId,
        publicBaseUrl: settings.s3.publicBaseUrl,
        forcePathStyle: settings.s3.forcePathStyle,
        secretAccessKeyMasked:
          settings.s3.secretAccessKeyEncrypted.length > 0
            ? maskSecret(decryptSecret(settings.s3.secretAccessKeyEncrypted))
            : "",
      },
      workspaces: workspaceRows.map((workspace) => {
        const drive = driveByWorkspace.get(workspace.id);
        return {
          id: workspace.id,
          name: workspace.name,
          driveConnected: Boolean(drive && drive.privateKeyEncrypted.length > 0),
          folderIdMasked: drive?.folderId ? `…${drive.folderId.slice(-6)}` : "",
          lastError: drive?.lastError ?? null,
          connectedAt: drive?.connectedAt ? drive.connectedAt.toISOString() : null,
        };
      }),
    },
    200,
  );
});

const putRoute = createRoute({
  method: "put",
  path: "/settings/storage",
  tags: ["CMS storage"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            driver: StorageDriverSchema,
            retentionDays: z.number().int().min(0).max(365),
            s3: z.object({
              endpoint: z.string(),
              region: z.string(),
              bucket: z.string(),
              accessKeyId: z.string(),
              secretAccessKey: z.string().optional(),
              publicBaseUrl: z.string(),
              forcePathStyle: z.boolean(),
            }),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Storage settings saved", content: { "application/json": { schema: StorageSettingsSchema } } },
    400: { description: "Invalid settings", content: errorContent },
  },
});

cmsStorageRoutes.openapi(putRoute, async (c) => {
  const auth = c.get("auth");
  const body = c.req.valid("json");
  const existing = await getRawStorageSettings(db);

  if (body.driver === "s3") {
    const missing = (["endpoint", "bucket", "accessKeyId"] as const).filter(
      (key) => body.s3[key].trim().length === 0,
    );
    if (missing.length > 0) {
      throw validation(`Isi endpoint, bucket, dan access key untuk driver S3 (${missing.join(", ")}).`);
    }
  }

  const nextSecret =
    body.s3.secretAccessKey && body.s3.secretAccessKey.trim().length > 0
      ? encryptSecret(body.s3.secretAccessKey.trim())
      : existing.s3.secretAccessKeyEncrypted;

  await writeSetting(db, SETTING_KEYS.storage, {
    ...DEFAULT_STORAGE,
    driver: body.driver,
    retentionDays: body.retentionDays,
    s3: {
      endpoint: body.s3.endpoint.trim(),
      region: body.s3.region.trim() || "auto",
      bucket: body.s3.bucket.trim(),
      accessKeyId: body.s3.accessKeyId.trim(),
      secretAccessKeyEncrypted: nextSecret,
      publicBaseUrl: body.s3.publicBaseUrl.trim(),
      forcePathStyle: body.s3.forcePathStyle,
    },
  });
  clearStorageCache();

  await logAudit(db, {
    actorUserId: auth.user.id,
    action: "settings.storage.update",
    targetType: "app_settings",
    targetId: SETTING_KEYS.storage,
    metadata: { driver: body.driver, retentionDays: body.retentionDays, bucket: body.s3.bucket.trim() },
    ip: clientIp(c),
  });

  return c.json(
    {
      driver: body.driver,
      retentionDays: body.retentionDays,
      s3: {
        endpoint: body.s3.endpoint.trim(),
        region: body.s3.region.trim() || "auto",
        bucket: body.s3.bucket.trim(),
        accessKeyId: body.s3.accessKeyId.trim(),
        publicBaseUrl: body.s3.publicBaseUrl.trim(),
        forcePathStyle: body.s3.forcePathStyle,
        secretAccessKeyMasked: nextSecret.length > 0 ? maskSecret(decryptSecret(nextSecret)) : "",
      },
      workspaces: [],
    },
    200,
  );
});

const testRoute = createRoute({
  method: "post",
  path: "/settings/storage/test",
  tags: ["CMS storage"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ driver: StorageDriverSchema }),
        },
      },
    },
  },
  responses: {
    200: { description: "Connection test", content: { "application/json": { schema: ProviderTestSchema } } },
  },
});

cmsStorageRoutes.openapi(testRoute, async (c) => {
  const { driver } = c.req.valid("json");
  const probeKey = `_probe/${crypto.randomUUID()}.txt`;

  try {
    if (driver === "local") {
      const local = new LocalStorageDriver(env.STORAGE_LOCAL_DIR, env.PUBLIC_API_URL);
      await local.put(probeKey, Buffer.from("rupakarsa", "utf8"), "text/plain");
      await local.remove(probeKey);
    } else {
      const settings = await getRawStorageSettings(db);
      if (settings.s3.bucket.trim().length === 0) {
        return c.json(
          { ok: false, message: "Isi dan simpan konfigurasi S3 terlebih dahulu." },
          200,
        );
      }
      const s3 = buildS3DriverFromInput({
        endpoint: settings.s3.endpoint,
        region: settings.s3.region,
        bucket: settings.s3.bucket,
        accessKeyId: settings.s3.accessKeyId,
        secretAccessKey:
          settings.s3.secretAccessKeyEncrypted.length > 0
            ? decryptSecret(settings.s3.secretAccessKeyEncrypted)
            : "",
        publicBaseUrl: settings.s3.publicBaseUrl,
        forcePathStyle: settings.s3.forcePathStyle,
      });
      await s3.put(probeKey, Buffer.from("rupakarsa", "utf8"), "text/plain");
      await s3.remove(probeKey);
    }
    return c.json({ ok: true, message: "Koneksi storage berhasil." }, 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Koneksi storage gagal.";
    return c.json({ ok: false, message }, 200);
  }
});

const usageRoute = createRoute({
  method: "get",
  path: "/settings/storage/usage",
  tags: ["CMS storage"],
  responses: {
    200: { description: "Asset usage counters", content: { "application/json": { schema: StorageUsageSchema } } },
  },
});

cmsStorageRoutes.openapi(usageRoute, async (c) => {
  return c.json(await storageUsage(), 200);
});

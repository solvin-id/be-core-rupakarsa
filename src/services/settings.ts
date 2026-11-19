import { eq } from "drizzle-orm";

import type { DbHandle } from "../db/client.js";
import { appSettings } from "../db/schema.js";

export const SETTING_KEYS = {
  contact: "admin_contact",
  pricing: "pricing",
  ai: "ai",
  storage: "storage",
  mail: "mail",
  payment: "payment",
  security: "security",
  limits: "limits",
} as const;

export interface Pricing {
  tokenValueRupiah: number;
  packageTokens: number;
  packagePlanQuota: number;
  planModeTokenCost: number;
}

export interface AdminContact {
  name: string;
  whatsapp: string;
  email: string;
}

export interface AiSettings {
  planModelId: string | null;
  analysisModelId: string | null;
  videoAnalysisModelId: string | null;
  defaultVideoModelId: string | null;
}

export interface S3Settings {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKeyEncrypted: string;
  publicBaseUrl: string;
  forcePathStyle: boolean;
}

export interface GDriveSettings {
  clientId: string;
  clientSecretEncrypted: string;
}

export interface StorageSettings {
  driver: "local" | "s3";
  retentionDays: number;
  s3: S3Settings;
  gdrive: GDriveSettings;
}

export interface MailSettings {
  driver: "smtp" | "log";
  fromName: string;
  fromEmail: string;
  smtp: { host: string; port: number; secure: boolean; user: string; passwordEncrypted: string };
}

export interface PaymentSettings {
  driver: "MANUAL" | "MIDTRANS";
  midtrans: { serverKeyEncrypted: string; clientKey: string; isProduction: boolean };
}

export interface SecuritySettings {
  requireTotpForCms: boolean;
  rateLimitFailClosed: boolean;
}

export interface LimitsSettings {
  generationsPerDayPerWorkspace: number;
  planRequestsPerHourPerUser: number;
  /** Brief textarea ceiling in the Plan Canvas. */
  planPromptMaxChars: number;
  /** Default final-prompt ceiling for models without their own `max_prompt_chars`. */
  finalPromptMaxChars: number;
  /** How many completed scenes one render may chain for continuity. */
  maxSceneChainScenes: number;
}

export const DEFAULT_PRICING: Pricing = {
  tokenValueRupiah: 500,
  packageTokens: 4000,
  packagePlanQuota: 250,
  planModeTokenCost: 1,
};

export const DEFAULT_CONTACT: AdminContact = {
  name: "Tim Rupakarsa",
  whatsapp: "",
  email: "halo@rupakarsa.id",
};

export const DEFAULT_AI: AiSettings = {
  planModelId: null,
  analysisModelId: null,
  videoAnalysisModelId: null,
  defaultVideoModelId: null,
};

export const DEFAULT_STORAGE: StorageSettings = {
  driver: "s3",
  retentionDays: 10,
  s3: {
    endpoint: "",
    region: "auto",
    bucket: "",
    accessKeyId: "",
    secretAccessKeyEncrypted: "",
    publicBaseUrl: "",
    forcePathStyle: true,
  },
  gdrive: { clientId: "", clientSecretEncrypted: "" },
};

export const DEFAULT_MAIL: MailSettings = {
  driver: "log",
  fromName: "Rupakarsa",
  fromEmail: "no-reply@rupakarsa.id",
  smtp: { host: "", port: 587, secure: false, user: "", passwordEncrypted: "" },
};

export const DEFAULT_PAYMENT: PaymentSettings = {
  driver: "MANUAL",
  midtrans: { serverKeyEncrypted: "", clientKey: "", isProduction: false },
};

export const DEFAULT_SECURITY: SecuritySettings = {
  requireTotpForCms: false,
  rateLimitFailClosed: false,
};

export const DEFAULT_LIMITS: LimitsSettings = {
  generationsPerDayPerWorkspace: 50,
  planRequestsPerHourPerUser: 60,
  planPromptMaxChars: 2000,
  finalPromptMaxChars: 4000,
  maxSceneChainScenes: 2,
};

export async function readSetting<T>(db: DbHandle, key: string, fallback: T): Promise<T> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, key)).limit(1);
  if (!row) return fallback;
  return row.value as T;
}

export async function writeSetting(db: DbHandle, key: string, value: unknown): Promise<void> {
  await db
    .insert(appSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
}

/** Seeds a default without clobbering a value an operator already saved through the CMS. */
export async function ensureSetting(db: DbHandle, key: string, value: unknown): Promise<void> {
  await db.insert(appSettings).values({ key, value }).onConflictDoNothing({ target: appSettings.key });
}

export async function getPricing(db: DbHandle): Promise<Pricing> {
  return { ...DEFAULT_PRICING, ...(await readSetting<Pricing>(db, SETTING_KEYS.pricing, DEFAULT_PRICING)) };
}

export async function getContact(db: DbHandle): Promise<AdminContact> {
  return {
    ...DEFAULT_CONTACT,
    ...(await readSetting<AdminContact>(db, SETTING_KEYS.contact, DEFAULT_CONTACT)),
  };
}

export async function getAiSettings(db: DbHandle): Promise<AiSettings> {
  return { ...DEFAULT_AI, ...(await readSetting<AiSettings>(db, SETTING_KEYS.ai, DEFAULT_AI)) };
}

async function readStorageSettings(db: DbHandle): Promise<StorageSettings> {
  const stored = await readSetting<StorageSettings>(db, SETTING_KEYS.storage, DEFAULT_STORAGE);
  return {
    ...DEFAULT_STORAGE,
    ...stored,
    s3: { ...DEFAULT_STORAGE.s3, ...(stored.s3 ?? {}) },
    gdrive: { ...DEFAULT_STORAGE.gdrive, ...(stored.gdrive ?? {}) },
  };
}

/** The OAuth app is usable for workspace consent only once both client fields are stored. */
export function googleOAuthConfigured(settings: StorageSettings): boolean {
  return (
    settings.gdrive.clientId.trim().length > 0 &&
    settings.gdrive.clientSecretEncrypted.trim().length > 0
  );
}

/**
 * A driver of `s3` only takes effect once a bucket is configured; otherwise the API keeps writing
 * to the local disk so a boot without settings still works.
 */
export async function getStorageSettings(db: DbHandle): Promise<StorageSettings> {
  const settings = await readStorageSettings(db);
  if (settings.driver === "s3" && settings.s3.bucket.trim().length === 0) {
    return { ...settings, driver: "local" };
  }
  return settings;
}

/** Raw stored shape, including the configured driver even when the bucket is still empty. */
export async function getRawStorageSettings(db: DbHandle): Promise<StorageSettings> {
  return readStorageSettings(db);
}

export async function getMailSettings(db: DbHandle): Promise<MailSettings> {
  const stored = await readSetting<MailSettings>(db, SETTING_KEYS.mail, DEFAULT_MAIL);
  return { ...DEFAULT_MAIL, ...stored, smtp: { ...DEFAULT_MAIL.smtp, ...(stored.smtp ?? {}) } };
}

export async function getPaymentSettings(db: DbHandle): Promise<PaymentSettings> {
  const stored = await readSetting<PaymentSettings>(db, SETTING_KEYS.payment, DEFAULT_PAYMENT);
  return {
    ...DEFAULT_PAYMENT,
    ...stored,
    midtrans: { ...DEFAULT_PAYMENT.midtrans, ...(stored.midtrans ?? {}) },
  };
}

export async function getSecuritySettings(db: DbHandle): Promise<SecuritySettings> {
  return {
    ...DEFAULT_SECURITY,
    ...(await readSetting<SecuritySettings>(db, SETTING_KEYS.security, DEFAULT_SECURITY)),
  };
}

export async function getLimitsSettings(db: DbHandle): Promise<LimitsSettings> {
  return {
    ...DEFAULT_LIMITS,
    ...(await readSetting<LimitsSettings>(db, SETTING_KEYS.limits, DEFAULT_LIMITS)),
  };
}

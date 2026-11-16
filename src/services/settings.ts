import { eq } from "drizzle-orm";

import type { DbHandle } from "../db/client.js";
import { appSettings } from "../db/schema.js";

export const SETTING_KEYS = {
  contact: "admin_contact",
  pricing: "pricing",
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

export async function getPricing(db: DbHandle): Promise<Pricing> {
  return { ...DEFAULT_PRICING, ...(await readSetting<Pricing>(db, SETTING_KEYS.pricing, DEFAULT_PRICING)) };
}

export async function getContact(db: DbHandle): Promise<AdminContact> {
  return {
    ...DEFAULT_CONTACT,
    ...(await readSetting<AdminContact>(db, SETTING_KEYS.contact, DEFAULT_CONTACT)),
  };
}

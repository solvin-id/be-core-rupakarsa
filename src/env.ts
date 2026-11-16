import "dotenv/config";

import { z } from "zod";

const rawSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8787),
  PUBLIC_API_URL: z.string().url().default("http://localhost:8787"),
  DATABASE_URL: z.string().min(1),
  TEST_DATABASE_URL: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1).default("redis://localhost:6380"),
  FRONTEND_ORIGINS: z
    .string()
    .default("http://localhost:3000,http://localhost:3001")
    .transform((value) =>
      value
        .split(",")
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    ),
  COOKIE_DOMAIN: z.string().default(""),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(7),
  APP_ENCRYPTION_KEY: z.string().default(""),
  STORAGE_DRIVER: z.enum(["local", "r2"]).default("local"),
  STORAGE_LOCAL_DIR: z.string().default("./var/media"),
  PROVIDER_MODE: z.enum(["stub", "live"]).default("stub"),
  RENDER_CONCURRENCY: z.coerce.number().int().positive().default(2),
  WORKER_HEARTBEAT_SECONDS: z.coerce.number().int().positive().default(10),
  METRICS_TOKEN: z.string().default(""),
  MEDIA_URL_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  SHUTDOWN_GRACE_SECONDS: z.coerce.number().int().positive().default(25),
  PUBLIC_CREATOR_URL: z.string().url().default("http://localhost:3000"),
  GENERATION_DRIVER: z.enum(["queue", "inline"]).default("queue"),
  SIMULATION_MODE: z
    .string()
    .default("true")
    .transform((value) => value !== "false"),
  RATE_LIMIT_DISABLED: z
    .string()
    .default("false")
    .transform((value) => value === "true"),
  SEED_SUPERADMIN_EMAIL: z.string().default("admin@rupakarsa.id"),
  SEED_SUPERADMIN_PASSWORD: z.string().default("rupakarsa"),
  DEMO_SEED_PASSWORD: z.string().default("rupakarsa"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  R2_ACCOUNT_ID: z.string().default(""),
  R2_ACCESS_KEY_ID: z.string().default(""),
  R2_SECRET_ACCESS_KEY: z.string().default(""),
  R2_BUCKET: z.string().default(""),
  R2_PUBLIC_BASE_URL: z.string().default(""),
  KENARI_BASE_URL: z.string().default("https://api.kenariai.com/v1"),
  KENARI_API_KEY: z.string().default(""),
  HIGGSFIELD_BASE_URL: z.string().default("https://platform.higgsfield.ai"),
  HIGGSFIELD_KEY_ID: z.string().default(""),
  HIGGSFIELD_KEY_SECRET: z.string().default(""),
});

type RawEnv = z.infer<typeof rawSchema>;
export type Env = Readonly<
  Omit<RawEnv, "FRONTEND_ORIGINS" | "SIMULATION_MODE" | "RATE_LIMIT_DISABLED"> & {
    FRONTEND_ORIGINS: readonly string[];
    SIMULATION_MODE: boolean;
    RATE_LIMIT_DISABLED: boolean;
  }
>;

function parseEnv(source: NodeJS.ProcessEnv): Env {
  const parsed = rawSchema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${detail}`);
  }
  const value = parsed.data;

  if (value.APP_ENCRYPTION_KEY.length > 0) {
    const bytes = Buffer.from(value.APP_ENCRYPTION_KEY, "base64");
    if (bytes.length !== 32) {
      throw new Error(
        "APP_ENCRYPTION_KEY must be a base64 string decoding to exactly 32 bytes (openssl rand -base64 32).",
      );
    }
  } else if (value.NODE_ENV === "production") {
    throw new Error("APP_ENCRYPTION_KEY is required in production.");
  }

  if (value.STORAGE_DRIVER === "r2") {
    const missing = (["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"] as const).filter(
      (key) => value[key].length === 0,
    );
    if (missing.length > 0) {
      throw new Error(`STORAGE_DRIVER=r2 requires: ${missing.join(", ")}`);
    }
  }

  return Object.freeze({
    ...value,
    FRONTEND_ORIGINS: Object.freeze([...value.FRONTEND_ORIGINS]) as readonly string[],
  });
}

export const env: Env = parseEnv(process.env);

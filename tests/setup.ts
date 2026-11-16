import "dotenv/config";

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tests run against the dedicated test database and the inline render driver. dotenv never
// overrides variables that are already set, so these win over .env.
process.env.NODE_ENV = "development";
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://rupakarsa:rupakarsa@localhost:5432/rupakarsa_test";
process.env.SIMULATION_MODE = "true";
process.env.GENERATION_DRIVER = "inline";
process.env.RATE_LIMIT_DISABLED = "true";
process.env.PROVIDER_MODE = "stub";
process.env.STORAGE_DRIVER = "local";
process.env.STORAGE_LOCAL_DIR ??= mkdtempSync(join(tmpdir(), "rupakarsa-media-"));
process.env.APP_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.LOG_LEVEL = "silent";
process.env.SEED_SUPERADMIN_EMAIL = "admin@rupakarsa.id";
process.env.SEED_SUPERADMIN_PASSWORD = "rupakarsa";
process.env.DEMO_SEED_PASSWORD = "rupakarsa";
process.env.PUBLIC_API_URL = "http://localhost:8787";

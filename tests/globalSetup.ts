import "dotenv/config";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

export default async function globalSetup(): Promise<void> {
  const url =
    process.env.TEST_DATABASE_URL ??
    "postgres://rupakarsa:rupakarsa@localhost:5432/rupakarsa_test";
  const sql = postgres(url, { max: 1, onnotice: () => {} });

  try {
    await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

import { migrate } from "drizzle-orm/postgres-js/migrator";

import { closeDb, db } from "./client.js";

const folder = process.env.MIGRATIONS_DIR ?? "./drizzle";
await migrate(db, { migrationsFolder: folder });
await closeDb();
process.stdout.write(`migrations applied from ${folder}\n`);

import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Sql } from "postgres";

import { env } from "../env.js";
import * as schema from "./schema.js";

export type DbSchema = typeof schema;
export type Database = PostgresJsDatabase<DbSchema>;
export type Tx = PgTransaction<PgQueryResultHKT, DbSchema, ExtractTablesWithRelations<DbSchema>>;
/** Either the root client or an open transaction; services accept both. */
export type DbHandle = Database | Tx;

export interface DbBundle {
  sql: Sql;
  db: Database;
}

export function createDb(connectionString: string, max = 10): DbBundle {
  const sql = postgres(connectionString, { max, onnotice: () => {} });
  const db = drizzle(sql, { schema });
  return { sql, db };
}

const primary = createDb(env.DATABASE_URL);

export const db = primary.db;
export const sql = primary.sql;

export async function closeDb(): Promise<void> {
  await primary.sql.end({ timeout: 5 });
}

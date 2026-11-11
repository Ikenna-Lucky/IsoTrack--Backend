import { neonConfig } from "@neondatabase/serverless";
import { telemetry, instrumentDatabaseFetch } from "../observability/telemetry";
import { drizzle as neonDrizzle } from "drizzle-orm/neon-http";
import { drizzle as postgresDrizzle } from "drizzle-orm/node-postgres";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { NeonHttpQueryResultHKT } from "drizzle-orm/neon-http";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import { createDatabaseTransport } from "./transport";
import { env } from "@/lib/env";
import * as schema from "./schema";

neonConfig.fetchFunction = instrumentDatabaseFetch(telemetry, fetch);
export const database = createDatabaseTransport({
  DATABASE_DRIVER: env.DATABASE_DRIVER,
  DATABASE_URL: env.DATABASE_URL,
  DEPLOYMENT_ENV: env.DEPLOYMENT_ENV,
  NODE_ENV: env.NODE_ENV,
});
export const db: PgDatabase<
  NeonHttpQueryResultHKT | NodePgQueryResultHKT,
  typeof schema
> =
  database.driver === "neon"
    ? neonDrizzle(database.client, { schema, logger: false })
    : postgresDrizzle(database.client, { schema, logger: false });

export type DB = typeof db;

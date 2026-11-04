import { neon, neonConfig } from "@neondatabase/serverless";
import { telemetry, instrumentDatabaseFetch } from "../observability/telemetry";
import { drizzle } from "drizzle-orm/neon-http";
import { env } from "@/lib/env";
import * as schema from "./schema";

neonConfig.fetchFunction = instrumentDatabaseFetch(telemetry, fetch);
const sql = neon(env.DATABASE_URL);

export const db = drizzle(sql, { schema, logger: false });

export type DB = typeof db;

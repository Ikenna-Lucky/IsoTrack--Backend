/**
 * Programmatic migration runner.
 * Run with: bun run src/db/migrate.ts
 *
 * Uses drizzle-kit's migrate() which applies pending SQL migrations
 * from the /drizzle folder to your Neon database.
 */
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { migrate } from "drizzle-orm/neon-http/migrator";
import { resolve } from "node:path";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL environment variable is not set.");
  console.error(
    "   Copy .env.example → .env and fill in your Neon connection string.",
  );
  process.exit(1);
}

async function runMigrations(): Promise<void> {
  console.log("🔄 Running database migrations...\n");

  const sql = neon(DATABASE_URL!);
  const db = drizzle(sql);

  const migrationsFolder = resolve(import.meta.dir, "../../drizzle");

  try {
    await migrate(db, { migrationsFolder });
    console.log("✅ All migrations applied successfully.\n");
  } catch (err) {
    console.error("❌ Migration failed:", err);
    process.exit(1);
  }
}

runMigrations();

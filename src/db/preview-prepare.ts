import { neon } from "@neondatabase/serverless";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import { hash, compare } from "bcryptjs";
import { fileURLToPath } from "node:url";
import { assertPreviewIsolation } from "../lib/preview-isolation.ts";
import { runMigrations } from "./migration-runner.ts";
import {
  previewAccounts,
  previewFixtureStatements,
} from "./preview-fixtures.ts";

async function main() {
  assertPreviewIsolation(process.env);
  const password = process.env.PREVIEW_FIXTURE_PASSWORD;
  if (!password || password.length < 32)
    throw new Error("Preview fixture password is required");
  const client = neon(process.env.DATABASE_URL!);
  const dialect = new PgDialect();
  const request = (s: SQL) => {
    const q = dialect.sqlToQuery(s);
    return client(q.sql, q.params);
  };
  const store = {
    execute: request,
    transaction: async (s: SQL[]) => {
      await client.transaction(s.map(request), {
        fetchOptions: { signal: AbortSignal.timeout(120000) },
      });
    },
  };
  await runMigrations(
    store,
    fileURLToPath(new URL("../../drizzle", import.meta.url)),
  );
  const users = await request(
    sql`select id,role,password_hash,is_active from users where id in ('preview-owner','preview-other','preview-driver','preview-customer')`,
  );
  if (users.length) {
    for (const [id, role] of previewAccounts) {
      const user = users.find((u) => u.id === id);
      if (
        !user ||
        user.role !== role ||
        !user.is_active ||
        !(await compare(password, String(user.password_hash)))
      )
        throw new Error(
          "Preview fixtures differ; inspect the isolated database",
        );
    }
  } else {
    await store.transaction(previewFixtureStatements(await hash(password, 12)));
  }
  console.log("Preview migrations and fixture accounts verified.");
}
main().catch(() => {
  console.error(
    "Preview preparation failed; inspect isolation settings and preview migration history.",
  );
  process.exitCode = 1;
});

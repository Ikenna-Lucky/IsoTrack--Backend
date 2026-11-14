import assert from "node:assert/strict";
import { test } from "node:test";
import { databaseConfig } from "../src/lib/database-config.ts";

test("Neon remains the default; Docker postgres must be explicitly selected", () => {
  assert.equal(
    databaseConfig({ DATABASE_URL: "postgresql://example.test/db" }).driver,
    "neon",
  );
  assert.equal(
    databaseConfig({
      DATABASE_DRIVER: "postgres",
      DATABASE_URL: "postgresql://127.0.0.1:55432/local",
    }).driver,
    "postgres",
  );
});
test("local postgres refuses hosted targets and hosted deployment modes", () => {
  const base = {
    DATABASE_DRIVER: "postgres",
    DATABASE_URL: "postgresql://127.0.0.1:55432/local",
  };
  for (const change of [
    { DATABASE_URL: "postgresql://live.example.test/db" },
    { DEPLOYMENT_ENV: "preview" },
    { DEPLOYMENT_ENV: "production" },
    { NODE_ENV: "production" },
    { DATABASE_URL: "https://localhost/db" },
  ])
    assert.throws(() => databaseConfig({ ...base, ...change }));
  assert.throws(() => databaseConfig({ DATABASE_URL: "" }));
  assert.throws(() =>
    databaseConfig({
      DATABASE_DRIVER: "unknown",
      DATABASE_URL: base.DATABASE_URL,
    }),
  );
});

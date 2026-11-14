import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";
import { parseEnv } from "node:util";
import { spawnSync } from "node:child_process";

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "isotrack-local-setup-test-"));
  const script = join(root, "scripts", "local-setup.mjs");
  mkdirSync(join(root, "scripts"));
  copyFileSync(new URL("../scripts/local-setup.mjs", import.meta.url), script);
  const execute = () =>
    spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
  try {
    run(root, execute);
  } finally {
    const rel = relative(resolve(tmpdir()), resolve(root));
    assert(
      !rel.startsWith("..") && rel.startsWith("isotrack-local-setup-test-"),
    );
    rmSync(root, { recursive: true, force: true });
  }
}

test("local setup refuses to overwrite a hosted target or echo its URL", () =>
  fixture((root, execute) => {
    const original =
      "DATABASE_URL=postgresql://fixture:private-fixture@hosted.example.test/db\n";
    writeFileSync(join(root, ".env"), original);
    const result = execute();
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(join(root, ".env"), "utf8"), original);
    assert(!existsSync(join(root, ".env.docker.local")));
    assert(!result.stderr.includes("private-fixture"));
  }));

test("local setup creates isolated credentials and preserves them on repeat", () =>
  fixture((root, execute) => {
    assert.equal(execute().status, 0);
    const first = readFileSync(join(root, ".env"), "utf8");
    const config = parseEnv(first);
    assert.equal(config.DATABASE_DRIVER, "postgres");
    assert.equal(new URL(config.DATABASE_URL).hostname, "127.0.0.1");
    assert.equal(new URL(config.UPSTASH_REDIS_URL).hostname, "127.0.0.1");
    assert.notEqual(config.JWT_SECRET, config.JWT_REFRESH_SECRET);
    assert.equal(config.NOTIFICATION_WORKERS_ENABLED, "false");
    assert.equal(config.STRIPE_MODE, "disabled");
    const again = execute();
    assert.equal(again.status, 0);
    assert.equal(readFileSync(join(root, ".env"), "utf8"), first);
    assert(!again.stdout.includes(config.JWT_SECRET));
  }));

test("missing Docker credentials fail rather than changing passwords for existing volumes", () =>
  fixture((root, execute) => {
    const original =
      "DATABASE_DRIVER=postgres\nDATABASE_URL=postgresql://127.0.0.1/local\n";
    writeFileSync(join(root, ".env"), original);
    assert.notEqual(execute().status, 0);
    assert.equal(readFileSync(join(root, ".env"), "utf8"), original);
    assert(!existsSync(join(root, ".env.docker.local")));
  }));

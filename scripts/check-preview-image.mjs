import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
const exec = promisify(execFile);
const image = process.argv[2];
const sha = process.env.GITHUB_SHA ?? "1".repeat(40);
if (!image || !/^[a-f0-9]{40}$/.test(sha))
  throw new Error("An image and full SHA are required");
const name = `isotrack-preview-image-test-${randomUUID()}`;
const env = {
  DATABASE_URL: "postgresql://fixture:fixture@preview-db.invalid/db",
  UPSTASH_REDIS_URL: "redis://preview-redis.invalid:6379",
  JWT_SECRET: "isolated-container-fixture-signature-key",
  JWT_REFRESH_SECRET: "isolated-container-fixture-refresh-key",
  DEPLOYMENT_ENV: "preview",
  NODE_ENV: "production",
  NOTIFICATION_WORKERS_ENABLED: "false",
  RETENTION_ENABLED: "false",
  STRIPE_MODE: "disabled",
  APP_URL: "https://preview-app.invalid",
  FRONTEND_URL: "https://preview-app.invalid",
  PREVIEW_DATABASE_HOST: "preview-db.invalid",
  LIVE_DATABASE_HOST: "live-db.invalid",
  PREVIEW_REDIS_HOST: "preview-redis.invalid",
  LIVE_REDIS_HOST: "live-redis.invalid",
  PREVIEW_APP_HOST: "preview-app.invalid",
  LIVE_APP_HOST: "live-app.invalid",
};
let started = false;
try {
  await exec(
    "docker",
    [
      "run",
      "--detach",
      "--rm",
      "--network",
      "none",
      "--name",
      name,
      ...Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]),
      image,
    ],
    { timeout: 30000 },
  );
  started = true;
  const inspected = await exec("docker", [
    "inspect",
    "--format",
    "{{.Config.User}}",
    name,
  ]);
  if (inspected.stdout.trim() !== "bun")
    throw new Error("Preview container must use the bun user");
  const probe = `const r=await fetch('http://127.0.0.1:8000/health/release'); const x=await r.json();if(!r.ok||x.sha!==${JSON.stringify(sha)}||x.environment!=='preview')process.exit(1);if((await fetch('http://127.0.0.1:8000/health/live')).status!==200)process.exit(1);`;
  let passed = false;
  for (let i = 0; i < 30; i++) {
    try {
      await exec("docker", ["exec", name, "bun", "-e", probe], {
        timeout: 5000,
      });
      passed = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  if (!passed) throw new Error("Preview container did not start");
  console.log(
    "Network-isolated preview image passed release/liveness checks as the bun user.",
  );
} finally {
  if (started)
    await exec("docker", ["stop", "--time", "5", name], { timeout: 15000 });
}

import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { assertPreviewIsolation } from "../src/lib/preview-isolation.ts";

export async function verifyPreview(
  config,
  {
    fetcher = fetch,
    wait = (ms) => new Promise((r) => setTimeout(r, ms)),
    attempts = 90,
  } = {},
) {
  assertPreviewIsolation(config);
  if (
    !config.PREVIEW_FIXTURE_PASSWORD ||
    config.PREVIEW_FIXTURE_PASSWORD.length < 32
  )
    throw new Error("Preview fixture password is required");
  const origin = new URL(config.APP_URL).origin;
  const deadline = Date.now() + 600000;
  const request = (path, options = {}) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      throw new Error("Preview verification deadline exceeded");
    return fetcher(`${origin}${path}`, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(Math.min(15000, remaining)),
    });
  };
  let ready = false;
  for (let i = 0; i < attempts; i++) {
    if (Date.now() > deadline) break;
    try {
      const response = await request("/health/release");
      const identity = await response.json();
      if (
        response.ok &&
        identity.environment === "preview" &&
        identity.sha === config.RELEASE_SHA &&
        (await request("/health/ready")).status === 200
      ) {
        ready = true;
        break;
      }
    } catch {
      /* Cold starts/builds can temporarily refuse connections. */
    }
    if (i < attempts - 1) await wait(5000);
  }
  if (!ready) throw new Error("Expected preview release did not become ready");
  const checks = [];
  async function check(name, path, status, options) {
    const response = await request(path, options);
    if (response.status !== status)
      throw new Error(`Preview check failed: ${name}`);
    checks.push({ name, status });
    return response;
  }
  await check("live", "/health/live", 200);
  await check(
    "anonymous shipment denied",
    "/api/v1/shipments/preview-shipment",
    401,
  );
  const publicResponse = await check(
    "public tracking",
    "/api/v1/track/IST-PREVIEW-ONLY",
    200,
  );
  const publicBody = await publicResponse.json();
  if (
    JSON.stringify(publicBody).includes("PRIVATE-PREVIEW") ||
    publicBody.data?.driver ||
    publicBody.data?.pickupAddress ||
    publicBody.data?.deliveryAddress
  )
    throw new Error("Public preview privacy check failed");
  for (const actor of ["owner", "other", "driver", "customer"]) {
    const login = await check(`login ${actor}`, "/api/v1/auth/login", 200, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: `preview-${actor}@example.invalid`,
        password: config.PREVIEW_FIXTURE_PASSWORD,
      }),
    });
    const { data } = await login.json();
    if (!data?.accessToken)
      throw new Error("Preview login returned no access token");
    const headers = { Authorization: `Bearer ${data.accessToken}` };
    await check(
      `shipment ${actor}`,
      "/api/v1/shipments/preview-shipment",
      actor === "other" ? 404 : 200,
      { headers },
    );
    await check(
      `history ${actor}`,
      "/api/v1/shipments/preview-shipment/events?limit=1",
      actor === "other" ? 404 : 200,
      { headers },
    );
    if (actor !== "other")
      await check(
        `foreign shipment ${actor}`,
        "/api/v1/shipments/preview-foreign-shipment",
        404,
        { headers },
      );
  }
  await check("oversized body", "/api/v1/shipments", 413, {
    method: "POST",
    body: "x".repeat(16385),
  });
  // Bounded sequential traffic verifies shared guard/peer wiring on the hosted path.
  let throttled = false;
  for (let i = 0; i < 13 && !throttled; i++) {
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        request("/api/v1/track/IST-PREVIEW-ONLY"),
      ),
    );
    for (const response of responses) {
      if (
        response.status === 429 &&
        Number(response.headers.get("Retry-After")) >= 1
      )
        throttled = true;
      else if (response.status !== 200)
        throw new Error("Preview request protection is unavailable");
      await response.arrayBuffer();
    }
  }
  if (!throttled) throw new Error("Preview tracking budget was not enforced");
  checks.push({ name: "tracking budget", status: 429 });
  return {
    sha: config.RELEASE_SHA,
    environment: "preview",
    checks,
    passed: true,
  };
}

export function assertPreviewBranch(ref) {
  if (ref !== "refs/heads/isotrack-preview-branch")
    throw new Error("Preview release requires isotrack-preview-branch");
}

async function main() {
<<<<<<< HEAD
  if (process.argv.slice(2).join(" ") !== "--verify-only")
=======
  const config = process.env;
  assertPreviewBranch(config.GITHUB_REF);
  const hook = deployHook(config);
  const response = await fetch(hook, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (response.status !== 200)
>>>>>>> c012b51267fbef0a1fb797988f55f38c55230b20
    throw new Error(
      "Use --verify-only after Render deploys; this script does not deploy",
    );
  const ref =
    process.env.GITHUB_REF ??
    `refs/heads/${execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim()}`;
  if (ref !== "refs/heads/isotrack-preview-branch")
    throw new Error("Smoke verification must run from isotrack-preview-branch");
  const config = {
    ...process.env,
    RELEASE_SHA:
      process.env.RELEASE_SHA ??
      execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  };
  const result = await verifyPreview(config);
  await mkdir("reports", { recursive: true });
  await writeFile(
    "reports/preview-smoke.json",
    JSON.stringify(
      { ...result, verifiedAt: new Date().toISOString() },
      null,
      2,
    ) + "\n",
  );
  console.log("Expected preview commit passed deployed smoke checks.");
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch(async () => {
    await mkdir("reports", { recursive: true });
    await writeFile(
      "reports/preview-smoke.json",
      JSON.stringify(
        {
          environment: "preview",
          passed: false,
          failedAt: new Date().toISOString(),
        },
        null,
        2,
      ) + "\n",
    );
    console.error(
      "Preview smoke verification failed. Inspect Render and the runbook; no deploy or database rollback was attempted.",
    );
    process.exitCode = 1;
  });

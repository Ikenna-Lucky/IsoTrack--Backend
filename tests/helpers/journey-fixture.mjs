import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import Redis from "ioredis";
import { PgDialect } from "drizzle-orm/pg-core";
import { runMigrations } from "../../src/db/migration-runner.ts";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const dialect = new PgDialect();

export function journeyFixture({ stripe } = {}) {
  const suffix = randomUUID();
  const containers = [];
  const logs = [];
  const databaseErrors = [];
  let pool, redis, proxy, child, base, interrupt;
  const docker = (...args) => exec("docker", args, { timeout: 60000 });
  const execute = async (statement) => {
    const query = dialect.sqlToQuery(statement);
    return (await pool.query(query.sql, query.params)).rows;
  };
  const store = {
    execute: async (statement) =>
      (await execute(statement)).map((row) => row.result ?? row),
  };
  async function container(name, port, image, extra = []) {
    const id = `isotrack-journey-${name}-${suffix}`;
    await docker(
      "run",
      "--detach",
      "--rm",
      "--name",
      id,
      "-p",
      `127.0.0.1::${port}`,
      ...extra,
      image,
    );
    containers.push(id);
    const { stdout } = await docker("port", id, `${port}/tcp`);
    return Number(stdout.trim().split(":").at(-1));
  }
  return {
    logs,
    databaseErrors,
    store,
    droppedResponses: 0,
    dropNextDatabaseResponseContaining(fragment) {
      interrupt = fragment;
    },
    deliverySecret: "ab".repeat(32),
    get base() {
      return base;
    },
    get pool() {
      return pool;
    },
    get redis() {
      return redis;
    },
    async start() {
      const password = randomUUID();
      const dbPort = await container("postgres", 5432, "postgres:17-alpine", [
        "--env",
        `POSTGRES_PASSWORD=${password}`,
      ]);
      const redisPort = await container("redis", 6379, "redis:7-alpine");
      pool = new pg.Pool({
        host: "127.0.0.1",
        port: dbPort,
        user: "postgres",
        password,
        database: "postgres",
        max: 8,
        connectionTimeoutMillis: 2000,
      });
      redis = new Redis(redisPort, "127.0.0.1", {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
      });
      redis.on("error", () => {});
      await redis.connect();
      const deadline = Date.now() + 30000;
      for (;;) {
        try {
          await pool.query("select 1");
          break;
        } catch (error) {
          if (Date.now() > deadline) throw error;
          await delay(100);
        }
      }
      await runMigrations(
        {
          execute,
          transaction: async (statements) => {
            const client = await pool.connect();
            try {
              await client.query("begin");
              for (const statement of statements) {
                const q = dialect.sqlToQuery(statement);
                await client.query(q.sql, q.params);
              }
              await client.query("commit");
            } catch (error) {
              await client.query("rollback");
              throw error;
            } finally {
              client.release();
            }
          },
        },
        fileURLToPath(new URL("../../drizzle", import.meta.url)),
      );

      // Neon-shaped HTTP responses, backed by actual PostgreSQL bound queries.
      // This substitutes vendor transport, never SQL results or database behavior.
      proxy = createServer(async (request, response) => {
        let client;
        try {
          let body = "";
          for await (const chunk of request) {
            body += chunk;
            if (body.length > 1048576)
              throw new Error("Oversized fixture query");
          }
          if (request.url.startsWith("/stripe/")) {
            if (!stripe) throw new Error("No Stripe fixture configured");
            const result = await stripe({
              path: request.url.slice("/stripe".length),
              method: request.method,
              body,
              headers: request.headers,
            });
            response.writeHead(result.status ?? 200, {
              "Content-Type": "application/json",
            });
            response.end(JSON.stringify(result.body));
            return;
          }
          const input = JSON.parse(body);
          client = await pool.connect();
          const batch = Array.isArray(input.queries);
          if (batch) await client.query("begin");
          const results = [];
          for (const query of batch ? input.queries : [input]) {
            const result = await client.query({
              text: query.query,
              values: query.params,
              rowMode: "array",
              types: { getTypeParser: () => (value) => value },
            });
            results.push({
              fields: result.fields,
              rows: result.rows,
              rowCount: result.rowCount,
              command: result.command,
            });
          }
          if (batch) await client.query("commit");
          if (
            interrupt &&
            (batch ? input.queries : [input]).some((query) =>
              query.query.includes(interrupt),
            )
          ) {
            // The SQL has committed; only its acknowledgement is lost.
            interrupt = undefined;
            this.droppedResponses++;
            // A disconnected socket can be transparently retried by Bun fetch.
            // HTTP 503 reliably reaches the application's failure boundary.
            response.writeHead(503, { "Content-Type": "text/plain" });
            response.end("Injected acknowledgement failure after commit");
            return;
          }
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify(batch ? { results } : results[0]));
        } catch (error) {
          if (client) await client.query("rollback").catch(() => {});
          databaseErrors.push({ code: error.code ?? "fixture_error" });
          response.writeHead(400, { "Content-Type": "application/json" });
          response.end(
            JSON.stringify({
              message: "Journey database query failed",
              code: error.code,
            }),
          );
        } finally {
          client?.release();
        }
      });
      proxy.listen(0, "127.0.0.1");
      await once(proxy, "listening");
      const endpoint = `http://127.0.0.1:${proxy.address().port}/sql`;
      child = spawn(
        process.env.BUN_EXECUTABLE ?? "bun",
        ["--no-env-file", "run", "tests/helpers/journey-server.mjs"],
        {
          cwd: root,
          windowsHide: true,
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            TEMP: process.env.TEMP,
            TMP: process.env.TMP,
            NODE_ENV: "production",
            DEPLOYMENT_ENV: "preview",
            PORT: "0",
            RELEASE_SHA: "a".repeat(40),
            NOTIFICATION_WORKERS_ENABLED: "false",
            RETENTION_ENABLED: "false",
            APP_URL: "https://preview.journey.invalid",
            FRONTEND_URL: "https://preview.journey.invalid",
            PREVIEW_APP_HOST: "preview.journey.invalid",
            LIVE_APP_HOST: "live.journey.invalid",
            DATABASE_URL:
              "postgresql://fixture:fixture@preview.database.invalid/postgres",
            PREVIEW_DATABASE_HOST: "preview.database.invalid",
            LIVE_DATABASE_HOST: "live.database.invalid",
            UPSTASH_REDIS_URL: `redis://127.0.0.1:${redisPort}`,
            PREVIEW_REDIS_HOST: "127.0.0.1",
            LIVE_REDIS_HOST: "live.redis.invalid",
            JWT_SECRET: randomUUID() + randomUUID(),
            JWT_REFRESH_SECRET: randomUUID() + randomUUID(),
            GMAIL_USER: "disabled@example.invalid",
            GMAIL_APP_PASSWORD: "disabled-fixture-only",
            DELIVERY_CODE_SECRET: this.deliverySecret,
            STRIPE_MODE: stripe ? "sandbox" : "disabled",
            ...(stripe
              ? {
                  STRIPE_SECRET_KEY: "sk_test_journey_fixture",
                  STRIPE_WEBHOOK_SECRET: "whsec_journey_fixture",
                  JOURNEY_STRIPE_FIXTURE: "true",
                }
              : {}),
            JOURNEY_DATABASE_ENDPOINT: endpoint,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Journey app startup timed out")),
          30000,
        );
        let pending = "";
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`Journey app exited: ${code}`));
        });
        child.stdout.on("data", (chunk) => {
          pending += chunk;
          const lines = pending.split(/\r?\n/);
          pending = lines.pop();
          for (const line of lines) {
            const match = /^JOURNEY_LISTENING:(\d+)$/.exec(line);
            if (match) {
              base = `http://127.0.0.1:${match[1]}`;
              clearTimeout(timer);
              resolve();
            } else {
              try {
                const event = JSON.parse(line);
                if (event.event) logs.push(event);
              } catch {
                /* Ignore unstructured output; never copy error bodies. */
              }
            }
          }
        });
        child.stderr.on("data", () => {});
      });
    },
    async stop() {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await Promise.race([exited, delay(5000)]);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await exited;
        }
      }
      if (proxy) {
        proxy.closeAllConnections();
        await new Promise((resolve) => proxy.close(resolve));
      }
      redis?.disconnect();
      await pool?.end();
      for (const id of containers.reverse())
        await docker("stop", "--time", "1", id);
    },
  };
}

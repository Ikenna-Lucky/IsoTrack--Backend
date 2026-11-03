import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { PgDialect } from "drizzle-orm/pg-core";

const execute = promisify(execFile);
const dialect = new PgDialect();

export function postgresFixture(options = {}) {
  const container =
    options.container ??
    `isotrack-${options.prefix ?? "socket"}-test-${randomUUID()}`;
  let started = false;
  const docker = (args) =>
    execute("docker", args, { encoding: "utf8", timeout: 60_000 });
  return {
    container,
    async start() {
      await docker([
        "run",
        "--detach",
        "--rm",
        "--name",
        container,
        "--env",
        "POSTGRES_PASSWORD=isolated-test-only",
        "postgres:17-alpine",
      ]);
      started = true;
      const deadline = Date.now() + 30_000;
      for (;;) {
        try {
          await docker(["exec", container, "pg_isready", "-U", "postgres"]);
          break;
        } catch (error) {
          if (Date.now() >= deadline) throw error;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    },
    async query(statement) {
      const compiled = dialect.sqlToQuery(statement);
      // Fixture adapter only. Production Drizzle continues to bind parameters.
      const text = compiled.sql.replace(/\$(\d+)/g, (_, index) => {
        const value = compiled.params[Number(index) - 1];
        if (value === null) return "NULL";
        if (typeof value === "number" && Number.isFinite(value))
          return String(value);
        if (typeof value !== "string")
          throw new Error("Unsupported fixture parameter");
        return `'${value.replaceAll("'", "''")}'`;
      });
      const process = execute(
        "docker",
        [
          "exec",
          "-i",
          container,
          "psql",
          "-U",
          "postgres",
          "-qAt",
          "-v",
          "ON_ERROR_STOP=1",
        ],
        { encoding: "utf8", timeout: 30_000 },
      );
      process.child.stdin.end(text);
      return (await process).stdout.trim();
    },
    async stop() {
      if (started) await docker(["stop", "--time", "1", container]);
    },
  };
}

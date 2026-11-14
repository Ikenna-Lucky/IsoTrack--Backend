import { neon } from "@neondatabase/serverless";
import pg from "pg";
import { databaseConfig } from "../lib/database-config.ts";

export interface DatabaseStatement {
  text: string;
  params?: unknown[];
}
export interface DatabaseOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}
type Rows = Record<string, unknown>[];

/** Raw SQL stores share this transport; Drizzle uses the same underlying client. */
export function createDatabaseTransport(
  config: Record<string, string | undefined>,
) {
  const settings = databaseConfig(config);
  if (settings.driver === "neon") {
    const client = neon(settings.url);
    return {
      driver: "neon" as const,
      client,
      query: async (
        text: string,
        params: unknown[] = [],
        options: DatabaseOptions = {},
      ): Promise<Rows> =>
        client(text, params, {
          fetchOptions: {
            signal:
              options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 5000),
          },
        }),
      transaction: async (
        statements: DatabaseStatement[],
        options: DatabaseOptions = {},
      ): Promise<Rows[]> =>
        client.transaction(
          statements.map(({ text, params }) => client(text, params ?? [])),
          {
            fetchOptions: {
              signal:
                options.signal ??
                AbortSignal.timeout(options.timeoutMs ?? 8000),
            },
          },
        ),
      close: async () => {},
    };
  }
  const pool = new pg.Pool({
    connectionString: settings.url,
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 120000,
  });
  // Pool errors have no active caller; do not print connection details.
  pool.on("error", () => {});
  async function withClient<T>(
    run: (client: pg.PoolClient) => Promise<T>,
    options: DatabaseOptions,
  ): Promise<T> {
    const signal =
      options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 5000);
    signal.throwIfAborted();
    const client = await pool.connect();
    let destroyed = false;
    const abort = () => {
      destroyed = true;
      client.release(true);
    };
    try {
      signal.throwIfAborted();
      signal.addEventListener("abort", abort, { once: true });
      return await run(client);
    } finally {
      signal.removeEventListener("abort", abort);
      if (!destroyed) client.release();
    }
  }
  return {
    driver: "postgres" as const,
    client: pool,
    query: async (
      text: string,
      params: unknown[] = [],
      options: DatabaseOptions = {},
    ): Promise<Rows> =>
      withClient(
        async (client) => (await client.query(text, params)).rows as Rows,
        options,
      ),
    transaction: async (
      statements: DatabaseStatement[],
      options: DatabaseOptions = {},
    ): Promise<Rows[]> =>
      withClient(async (client) => {
        await client.query("BEGIN");
        try {
          const results: Rows[] = [];
          for (const statement of statements)
            results.push(
              (await client.query(statement.text, statement.params ?? []))
                .rows as Rows,
            );
          await client.query("COMMIT");
          return results;
        } catch (error) {
          try {
            await client.query("ROLLBACK");
          } catch {
            /* A disconnected client is already discarded. */
          }
          throw error;
        }
      }, options),
    close: () => pool.end(),
  };
}

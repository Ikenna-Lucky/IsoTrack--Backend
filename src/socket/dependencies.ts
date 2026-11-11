import { database } from "@/db";
import { reportDependency } from "../observability/runtime";
import { verifyAccessToken } from "@/lib/jwt";
import {
  socketAccessStatement,
  recordSocketLocationStatement,
} from "@/db/queries/socket-access";
import type { TrackingDependencies } from "./handlers";
import type { SocketGrant } from "./protocol";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const dialect = new PgDialect();
function execute(statement: SQL) {
  const query = dialect.sqlToQuery(statement);
  return database.query(query.sql, query.params, {
    signal: AbortSignal.timeout(5000),
  });
}

export const trackingDependencies: TrackingDependencies = {
  verifyToken: verifyAccessToken,
  authorize: async (identities, trackingId) => {
    const result = await execute(socketAccessStatement(identities, trackingId));
    return result.map((row) => ({
      socketId: String(row.socket_id),
      role: row.role as SocketGrant["role"],
    }));
  },
  recordLocation: async (identity, location) =>
    (await execute(recordSocketLocationStatement(identity, location)))
      .length === 1,
  reportError: () => reportDependency("tracking"),
};

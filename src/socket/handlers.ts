import type { Server, Socket } from "socket.io";
import {
  trackingIdSchema,
  locationSchema,
  isFreshLocation,
} from "./protocol.ts";
import type { SocketIdentity, SocketGrant, LocationPayload } from "./protocol";

export interface TrackingDependencies {
  verifyToken: (
    token: string,
  ) => Promise<{ sub: string; sid: string; exp?: number }>;
  authorize: (
    identities: readonly SocketIdentity[],
    trackingId?: string,
  ) => Promise<SocketGrant[]>;
  recordLocation: (
    identity: SocketIdentity,
    location: LocationPayload,
  ) => Promise<boolean>;
  reportError: (operation: string) => void;
}
interface Connection {
  socket: Socket;
  identity: SocketIdentity;
  subscriptions: Set<string>;
  busy: boolean;
  windowStart: number;
  requests: number;
}
type Result = { ok: true } | { ok: false; code: string };
const BATCH_SIZE = 100;

export function registerSocketHandlers(
  io: Server,
  deps: TrackingDependencies,
  options = { sessionCheckIntervalMs: 15_000 },
) {
  const authenticated = new WeakMap<Socket, SocketIdentity>();
  const connections = new Map<string, Connection>();
  const userConnections = new Map<string, number>();
  const reply = (ack: unknown, result: Result) => {
    if (typeof ack === "function") ack(result);
  };

  io.use((socket, next) => {
    const authenticate = async () => {
      const token: unknown = socket.handshake.auth?.token;
      if (typeof token !== "string" || token.length > 4096)
        throw new Error("Invalid token");
      const payload = await deps.verifyToken(token);
      if (!payload.exp || payload.exp * 1000 <= Date.now())
        throw new Error("Expired token");
      const identity = {
        socketId: socket.id,
        userId: payload.sub,
        sessionId: payload.sid,
        expiresAt: payload.exp,
      };
      if (!(await deps.authorize([identity])).length)
        throw new Error("Inactive session");
      authenticated.set(socket, identity);
      next();
    };
    void authenticate().catch(() =>
      next(
        Object.assign(new Error("Authentication failed"), {
          data: { code: "UNAUTHORIZED" },
        }),
      ),
    );
  });

  async function deliver(trackingId: string, location: LocationPayload) {
    const targets = [
      ...(io.sockets.adapter.rooms.get(`shipment:${trackingId}`) ?? []),
    ].flatMap((id) => {
      const connection = connections.get(id);
      return connection ? [connection] : [];
    });
    for (let offset = 0; offset < targets.length; offset += BATCH_SIZE) {
      const batch = targets.slice(offset, offset + BATCH_SIZE);
      const permitted = new Set(
        (
          await deps.authorize(
            batch.map((c) => c.identity),
            trackingId,
          )
        ).map((g) => g.socketId),
      );
      for (const target of batch) {
        if (!permitted.has(target.socket.id)) {
          target.subscriptions.delete(trackingId);
          await target.socket.leave(`shipment:${trackingId}`);
          continue;
        }
        if (
          target.socket.connected &&
          target.subscriptions.has(trackingId) &&
          target.identity.expiresAt * 1000 > Date.now()
        ) {
          // Volatile packets prevent slow clients from accumulating GPS history.
          target.socket.volatile.emit("driver:location", {
            ...location,
            heading: location.heading ?? 0,
            speed: location.speed ?? 0,
          });
        }
      }
    }
  }

  io.on("connection", (socket) => {
    const authenticatedIdentity = authenticated.get(socket);
    if (
      !authenticatedIdentity ||
      (userConnections.get(authenticatedIdentity.userId) ?? 0) >= 5
    ) {
      socket.disconnect(true);
      return;
    }
    const identity = authenticatedIdentity;
    const state: Connection = {
      socket,
      identity,
      subscriptions: new Set(),
      busy: false,
      windowStart: Date.now(),
      requests: 0,
    };
    connections.set(socket.id, state);
    userConnections.set(
      identity.userId,
      (userConnections.get(identity.userId) ?? 0) + 1,
    );

    function run(
      ack: unknown,
      operation: (grant: SocketGrant) => Promise<Result>,
    ) {
      const now = Date.now();
      if (now - state.windowStart >= 1000) {
        state.windowStart = now;
        state.requests = 0;
      }
      if (++state.requests > 10) {
        reply(ack, { ok: false, code: "RATE_LIMITED" });
        return;
      }
      if (state.busy) {
        reply(ack, { ok: false, code: "BUSY" });
        return;
      }
      state.busy = true;
      const execute = async () => {
        const grant = (await deps.authorize([identity]))[0];
        if (!grant || identity.expiresAt * 1000 <= Date.now()) {
          reply(ack, { ok: false, code: "UNAUTHORIZED" });
          socket.disconnect(true);
          return;
        }
        if (!socket.connected) return;
        reply(ack, await operation(grant));
      };
      void execute()
        .catch(() => {
          deps.reportError("socket_event");
          reply(ack, { ok: false, code: "UNAVAILABLE" });
          socket.disconnect(true);
        })
        .finally(() => {
          state.busy = false;
        });
    }

    socket.on("shipment:join", (value: unknown, ack: unknown) => {
      run(ack, async () => {
        const parsed = trackingIdSchema.safeParse(value);
        if (!parsed.success) return { ok: false, code: "INVALID_PAYLOAD" };
        if (
          state.subscriptions.size >= 20 &&
          !state.subscriptions.has(parsed.data)
        )
          return { ok: false, code: "SUBSCRIPTION_LIMIT" };
        if (!(await deps.authorize([identity], parsed.data)).length)
          return { ok: false, code: "FORBIDDEN" };
        if (!socket.connected) return { ok: false, code: "UNAUTHORIZED" };
        await socket.join(`shipment:${parsed.data}`);
        state.subscriptions.add(parsed.data);
        socket.emit("shipment:joined", { trackingId: parsed.data });
        return { ok: true };
      });
    });
    socket.on("shipment:leave", (value: unknown, ack: unknown) => {
      run(ack, async () => {
        const parsed = trackingIdSchema.safeParse(value);
        if (!parsed.success) return { ok: false, code: "INVALID_PAYLOAD" };
        state.subscriptions.delete(parsed.data);
        await socket.leave(`shipment:${parsed.data}`);
        return { ok: true };
      });
    });
    socket.on("driver:location", (value: unknown, ack: unknown) => {
      run(ack, async (grant) => {
        const parsed = locationSchema.safeParse(value);
        if (!parsed.success || !isFreshLocation(parsed.data, Date.now()))
          return { ok: false, code: "INVALID_PAYLOAD" };
        if (grant.role !== "driver") return { ok: false, code: "FORBIDDEN" };
        if (!(await deps.recordLocation(identity, parsed.data)))
          return { ok: false, code: "LOCATION_REJECTED" };
        if (socket.connected)
          await deliver(parsed.data.trackingId, parsed.data);
        return { ok: true };
      });
    });
    socket.on("disconnect", () => {
      connections.delete(socket.id);
      const remaining = (userConnections.get(identity.userId) ?? 1) - 1;
      if (remaining) userConnections.set(identity.userId, remaining);
      else userConnections.delete(identity.userId);
    });
  });

  let checking = false;
  const timer = setInterval(() => {
    if (checking) return;
    checking = true;
    const check = async () => {
      const states = [...connections.values()];
      for (let offset = 0; offset < states.length; offset += BATCH_SIZE) {
        const batch = states.slice(offset, offset + BATCH_SIZE);
        const permitted = new Set(
          (await deps.authorize(batch.map((c) => c.identity))).map(
            (g) => g.socketId,
          ),
        );
        for (const state of batch) {
          if (
            !permitted.has(state.socket.id) ||
            state.identity.expiresAt * 1000 <= Date.now()
          )
            state.socket.disconnect(true);
        }
      }
    };
    void check()
      .catch(() => {
        deps.reportError("socket_session_check");
        for (const state of connections.values()) state.socket.disconnect(true);
      })
      .finally(() => {
        checking = false;
      });
  }, options.sessionCheckIntervalMs);
  timer.unref();
  const dispose = () => clearInterval(timer);
  io.httpServer?.once("close", dispose);
  return dispose;
}

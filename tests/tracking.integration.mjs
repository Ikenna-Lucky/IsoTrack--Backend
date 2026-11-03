import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { Server } from "socket.io";
import { io as client } from "socket.io-client";
import { SignJWT } from "jose";
import { sql } from "drizzle-orm";
import { postgresFixture } from "./helpers/postgres.mjs";
import { registerSocketHandlers } from "../src/socket/handlers.ts";
import { trackingServerOptions } from "../src/socket/server-options.ts";
import { verifySessionToken } from "../src/lib/token-verification.ts";
import { requireSessionClaims } from "../src/lib/session-claims.ts";
import {
  socketAccessStatement,
  recordSocketLocationStatement,
} from "../src/db/queries/socket-access.ts";
import {
  openSessionStatement,
  revokeSessionStatement,
} from "../src/db/queries/session-statements.ts";

const postgres = postgresFixture();
const secret = new TextEncoder().encode(
  "socket-integration-signing-key-32-chars",
);
const sockets = new Set();
let url;
let server;
let io;
let dispose;
let unavailable = false;
const origin = "https://app.example.test";
const nextEvent = (socket, name) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(name, handler);
      reject(new Error(`Timed out waiting for ${name}`));
    }, 8000);
    const handler = (...values) => {
      clearTimeout(timer);
      resolve(values[0]);
    };
    socket.once(name, handler);
  });
const emit = (socket, name, payload) =>
  socket.timeout(5000).emitWithAck(name, payload);

before(async () => {
  await postgres.start();
  for (const migration of [
    "0000_graceful_the_enforcers",
    "0002_private_fleets",
    "0003_driver_invitations",
    "0004_stripe_checkout",
    "0005_auth_sessions",
  ]) {
    await postgres.query(
      sql.raw(
        await readFile(
          new URL(`../drizzle/${migration}.sql`, import.meta.url),
          "utf8",
        ),
      ),
    );
  }
  await postgres.query(
    sql.raw(`insert into users(id,email,password_hash,name,role) values
    ('owner-a','owner-a@test.example','hash','A','business'), ('owner-b','owner-b@test.example','hash','B','business'),
    ('rider-a','rider-a@test.example','hash','A','driver'), ('rider-b','rider-b@test.example','hash','B','driver'),
    ('customer-a','customer-a@test.example','hash','A','customer'), ('customer-b','customer-b@test.example','hash','B','customer');
    insert into businesses(id,user_id,business_name) values ('biz-a','owner-a','A'),('biz-b','owner-b','B');
    insert into drivers(id,user_id,business_id,vehicle_type,vehicle_plate) values
      ('driver-a','rider-a','biz-a','bike','A'),('driver-b','rider-b','biz-b','bike','B');`),
  );
  server = createServer();
  io = new Server(server, trackingServerOptions(origin));
  dispose = registerSocketHandlers(
    io,
    {
      verifyToken: async (token) => {
        const payload = await verifySessionToken(token, secret, "access");
        requireSessionClaims(payload, false);
        return payload;
      },
      authorize: async (identities, trackingId) => {
        if (unavailable) throw new Error("simulated storage outage");
        const result = await postgres.query(
          socketAccessStatement(identities, trackingId),
        );
        return result
          ? result.split("\n").map((line) => {
              const [socketId, role] = line.split("|");
              return { socketId, role };
            })
          : [];
      },
      recordLocation: async (identity, location) =>
        Boolean(
          await postgres.query(
            recordSocketLocationStatement(identity, location),
          ),
        ),
      reportError: () => {},
    },
    { sessionCheckIntervalMs: 200 },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  url = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  for (const socket of sockets) socket.disconnect();
  dispose?.();
  if (io) await new Promise((resolve) => io.close(resolve));
  await postgres.stop();
});

let sequence = 0;
async function credentials(userId, options = {}) {
  const sid = `socket_session_${String(++sequence).padStart(6, "0")}`;
  const version = Number(
    await postgres.query(
      sql`select credential_version from users where id=${userId}`,
    ),
  );
  await postgres.query(openSessionStatement(sid, userId, version, 3600));
  const token = await new SignJWT({
    sid,
    type: "access",
    role:
      options.role ??
      (userId.startsWith("rider")
        ? "driver"
        : userId.startsWith("owner")
          ? "business"
          : "customer"),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(options.exp ?? "1h")
    .sign(secret);
  return { token, sid, userId };
}
function connection(auth, options = {}) {
  const socket = client(url, {
    autoConnect: false,
    reconnection: false,
    forceNew: true,
    transports: ["websocket"],
    auth,
    extraHeaders: { Origin: origin },
    ...options,
  });
  sockets.add(socket);
  return socket;
}
async function connect(userId, options = {}) {
  const credential = await credentials(userId, options);
  const socket = connection(
    { token: credential.token, userId: "spoofed", role: "driver" },
    options.client,
  );
  const connected = nextEvent(socket, "connect");
  socket.connect();
  await connected;
  return { socket, credential };
}
async function fixture(label, driver = "driver-a") {
  const id = `tracking-${label}`;
  const trackingId = `IST-${label}`;
  await postgres.query(sql`insert into shipments(id,tracking_id,business_id,driver_id,customer_id,description,weight_kg,pickup_address,delivery_address,price_kobo,status)
    values (${id},${trackingId},'biz-a',${driver},'customer-a','test',1,'{}','{}',100,'assigned')`);
  return { id, trackingId };
}
const location = (trackingId, overrides = {}) => ({
  trackingId,
  lat: 6.5,
  lng: 3.4,
  timestamp: Date.now(),
  ...overrides,
});

test("anonymous, invalid, expired, legacy and revoked socket credentials are rejected", async () => {
  const revoked = await credentials("customer-a");
  await postgres.query(revokeSessionStatement(revoked.sid, revoked.userId));
  const expired = await credentials("customer-a", {
    exp: Math.floor(Date.now() / 1000) - 1,
  });
  const legacy = await new SignJWT({ type: "access", role: "customer" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("customer-a")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(secret);
  for (const auth of [
    {},
    { token: "invalid" },
    { token: expired.token },
    { token: legacy },
    { token: revoked.token },
  ]) {
    const socket = connection(auth);
    const failed = nextEvent(socket, "connect_error");
    socket.connect();
    assert.equal((await failed).data.code, "UNAUTHORIZED");
    socket.disconnect();
  }
});

test("authorized participants join; other businesses, customers and drivers cannot", async () => {
  const shipment = await fixture("participants");
  for (const user of [
    "owner-a",
    "customer-a",
    "rider-a",
    "owner-b",
    "customer-b",
    "rider-b",
  ]) {
    const { socket } = await connect(user);
    assert.deepEqual(
      await emit(socket, "shipment:join", shipment.trackingId),
      user.endsWith("-a") ? { ok: true } : { ok: false, code: "FORBIDDEN" },
    );
    socket.disconnect();
  }
});

test("only the assigned driver publishes persisted locations to authorized subscribers", async () => {
  const shipment = await fixture("publish");
  const viewer = await connect("customer-a");
  const driver = await connect("rider-a");
  assert.deepEqual(
    await emit(viewer.socket, "shipment:join", shipment.trackingId),
    { ok: true },
  );
  const received = nextEvent(viewer.socket, "driver:location");
  const payload = location(shipment.trackingId);
  assert.deepEqual(await emit(driver.socket, "driver:location", payload), {
    ok: true,
  });
  assert.deepEqual(await received, { ...payload, heading: 0, speed: 0 });
  assert.equal(
    await postgres.query(
      sql`select current_location->>'lat' from shipments where id=${shipment.id}`,
    ),
    "6.5",
  );
  viewer.socket.disconnect();
  driver.socket.disconnect();
  for (const user of ["owner-a", "customer-a", "rider-b"]) {
    const { socket } = await connect(user);
    const result = await emit(
      socket,
      "driver:location",
      location(shipment.trackingId),
    );
    assert.equal(result.ok, false);
    socket.disconnect();
  }
});

test("spoofed identities, malformed coordinates and stale timestamps never write", async () => {
  const shipment = await fixture("invalid");
  const { socket } = await connect("rider-a");
  for (const override of [
    { driverId: "driver-b" },
    { lat: 91 },
    { lng: -181 },
    { speed: -1 },
    { timestamp: Date.now() - 60000 },
    { timestamp: Date.now() + 60000 },
  ]) {
    assert.deepEqual(
      await emit(
        socket,
        "driver:location",
        location(shipment.trackingId, override),
      ),
      { ok: false, code: "INVALID_PAYLOAD" },
    );
  }
  assert.equal(
    await postgres.query(
      sql`select current_location is null from shipments where id=${shipment.id}`,
    ),
    "t",
  );
  socket.disconnect();
});

test("reassignment removes an old subscriber before broadcasting another driver's GPS", async () => {
  const shipment = await fixture("reassigned");
  const old = await connect("rider-a");
  assert.deepEqual(
    await emit(old.socket, "shipment:join", shipment.trackingId),
    { ok: true },
  );
  // Move the shipment and driver together to respect the private fleet FK.
  await postgres.query(
    sql`update shipments set business_id='biz-b',driver_id='driver-b' where id=${shipment.id}`,
  );
  const replacement = await connect("rider-b");
  let received = 0;
  old.socket.on("driver:location", () => received++);
  assert.deepEqual(
    await emit(old.socket, "driver:location", location(shipment.trackingId)),
    { ok: false, code: "LOCATION_REJECTED" },
  );
  assert.deepEqual(
    await emit(
      replacement.socket,
      "driver:location",
      location(shipment.trackingId),
    ),
    { ok: true },
  );
  assert.equal(received, 0);
  assert.equal(
    io.sockets.adapter.rooms
      .get(`shipment:${shipment.trackingId}`)
      ?.has(old.socket.id) ?? false,
    false,
  );
  old.socket.disconnect();
  replacement.socket.disconnect();
});

test("logout disconnects idle sockets and revoked credentials cannot reconnect", async () => {
  const { socket, credential } = await connect("customer-a");
  const disconnected = nextEvent(socket, "disconnect");
  await postgres.query(
    revokeSessionStatement(credential.sid, credential.userId),
  );
  assert.equal(await disconnected, "io server disconnect");
  const failed = nextEvent(socket, "connect_error");
  socket.connect();
  assert.equal((await failed).data.code, "UNAUTHORIZED");
  socket.disconnect();
});

test("token expiry disconnects an idle connection", async () => {
  const { socket } = await connect("customer-a", {
    exp: Math.floor(Date.now() / 1000) + 4,
  });
  assert.equal(await nextEvent(socket, "disconnect"), "io server disconnect");
});

test("reconnect requires a fresh handshake and explicit room subscription", async () => {
  const shipment = await fixture("reconnect");
  const { socket } = await connect("customer-a", {
    client: { transports: ["polling"] },
  });
  assert.deepEqual(await emit(socket, "shipment:join", shipment.trackingId), {
    ok: true,
  });
  const previous = socket.id;
  socket.disconnect();
  const connected = nextEvent(socket, "connect");
  socket.connect();
  await connected;
  assert.notEqual(socket.id, previous);
  assert.equal(
    io.sockets.adapter.rooms
      .get(`shipment:${shipment.trackingId}`)
      ?.has(socket.id) ?? false,
    false,
  );
  assert.deepEqual(await emit(socket, "shipment:join", shipment.trackingId), {
    ok: true,
  });
  socket.disconnect();
});

test("database outages fail closed without leaking internal errors", async () => {
  const { socket } = await connect("customer-a");
  const disconnected = nextEvent(socket, "disconnect");
  unavailable = true;
  try {
    assert.equal(await disconnected, "io server disconnect");
    const denied = connection({
      token: (await credentials("customer-a")).token,
    });
    const failed = nextEvent(denied, "connect_error");
    denied.connect();
    assert.equal((await failed).message, "Authentication failed");
    denied.disconnect();
  } finally {
    unavailable = false;
  }
});

test("simultaneous locations across sessions accept one write and preserve monotonic GPS", async () => {
  const shipment = await fixture("write-race");
  const credentialsA = await credentials("rider-a");
  const credentialsB = await credentials("rider-a");
  const identity = (c) => ({
    socketId: c.sid,
    userId: c.userId,
    sessionId: c.sid,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });
  const payload = location(shipment.trackingId);
  const outcomes = await Promise.all(
    [credentialsA, credentialsB].map((c, index) =>
      postgres.query(
        recordSocketLocationStatement(identity(c), {
          ...payload,
          timestamp: payload.timestamp + index,
        }),
      ),
    ),
  );
  assert.equal(outcomes.filter(Boolean).length, 1);
  assert.equal(
    await postgres.query(
      recordSocketLocationStatement(identity(credentialsA), {
        ...payload,
        timestamp: payload.timestamp - 1,
      }),
    ),
    "",
  );
  await postgres.query(
    sql`update shipments set status='delivered' where id=${shipment.id}`,
  );
  assert.equal(
    await postgres.query(
      recordSocketLocationStatement(
        identity(credentialsA),
        location(shipment.trackingId),
      ),
    ),
    "",
  );
});

test("packet bursts have bounded in-flight work and an explicit rate limit", async () => {
  const { socket } = await connect("customer-a");
  const results = await Promise.all(
    Array.from({ length: 12 }, () =>
      emit(socket, "shipment:join", "IST-unknown"),
    ),
  );
  assert.ok(results.some((result) => result.code === "BUSY"));
  assert.ok(results.some((result) => result.code === "RATE_LIMITED"));
  socket.disconnect();
});

test("untrusted origins and oversized messages are rejected by the real transport", async () => {
  const credential = await credentials("customer-a");
  const foreign = connection(
    { token: credential.token },
    { extraHeaders: { Origin: "https://foreign.example.test" } },
  );
  const rejected = nextEvent(foreign, "connect_error");
  foreign.connect();
  await rejected;
  assert.equal(foreign.connected, false);
  foreign.disconnect();
  const { socket } = await connect("customer-a");
  const disconnected = nextEvent(socket, "disconnect");
  socket.emit("driver:location", { padding: "x".repeat(9000) });
  await disconnected;
  assert.equal(socket.connected, false);
});

test("password changes and deactivation disconnect live sockets", async () => {
  for (const change of [
    sql`update users set password_hash='changed-hash' where id='customer-a'`,
    sql`update users set is_active=false where id='customer-a'`,
  ]) {
    const { socket } = await connect("customer-a");
    const disconnected = nextEvent(socket, "disconnect");
    await postgres.query(change);
    assert.equal(await disconnected, "io server disconnect");
  }
  await postgres.query(
    sql`update users set is_active=true where id='customer-a'`,
  );
});

test("current database roles override stale role claims in an access token", async () => {
  const shipment = await fixture("stale-role");
  const { socket } = await connect("customer-a", { role: "driver" });
  assert.deepEqual(
    await emit(socket, "driver:location", location(shipment.trackingId)),
    { ok: false, code: "FORBIDDEN" },
  );
  socket.disconnect();
});

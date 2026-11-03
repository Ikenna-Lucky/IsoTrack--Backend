# Real-time shipment tracking

Socket.IO now requires an active authenticated session. Authentication uses the
same signed access token as HTTP, including its session identifier and expiry.
The current database role determines permissions; client-supplied user IDs, driver
IDs and roles never grant access.

## Client contract

Connect with `io(apiUrl, { auth: { token: accessToken } })`. Tokens in URL query
parameters, tracking links and refresh cookies are not socket credentials. Browser
origins must match `FRONTEND_URL`. Native clients may omit Origin but still need a
valid access token. The server uses the same policy for polling and WebSocket.

After connection, emit `shipment:join` with the tracking ID as a string. The business
owner, shipment customer and currently assigned driver in the same private fleet
may join. Unauthorized and unknown shipments both return `FORBIDDEN`. At most 20
shipments may be subscribed to per socket. `shipment:leave` accepts the same string.
Successful joins also emit `shipment:joined` with `{ trackingId }` for compatibility.

Use acknowledgements for all three events:

```js
const result = await socket.timeout(5000).emitWithAck("shipment:join", trackingId);
// result: { ok: true } or { ok: false, code: "FORBIDDEN" }
```

Only an assigned driver may send `driver:location`:

```js
{
  trackingId: "IST-example",
  lat: 6.5,
  lng: 3.4,
  timestamp: Date.now(), // Unix milliseconds from the measured GPS sample
  heading: 90,          // optional degrees, >= 0 and < 360
  speed: 8             // optional metres/second, >= 0 and <= 100
}
```

Unknown fields are rejected. Coordinates must be finite and within latitude and
longitude ranges. Samples may be at most 30 seconds old or 5 seconds ahead of the
server. Clients need reasonably synchronized clocks. A rejected sample is not a
successful write; do not treat acknowledgement timeouts as accepted locations.

The database atomically checks the session, account, role, fleet, assignment,
shipment status, sample order and write frequency. Only assigned/picked-up/in-transit/
out-for-delivery shipments accept GPS. Samples must advance the previous measured
timestamp. At most one write per second per shipment is accepted across sessions
or application processes. The server stores `receivedAt` separately using its
database clock. This is basic freshness/order validation, not proof that reported
coordinates are physically authentic.

Authorized subscribers receive `driver:location` with the validated payload,
including tracking ID, and heading/speed defaulting to zero. Delivery uses volatile
packets: slow clients may miss samples, and no GPS backlog is replayed. Reload the
authorized shipment detail for the last persisted location. A persisted write and
socket delivery are not an atomic transaction; delivery failure can leave a valid
stored sample without a broadcast. Subsequent samples converge on the latest GPS.

Errors include `INVALID_PAYLOAD`, `FORBIDDEN`, `LOCATION_REJECTED`, `BUSY`,
`RATE_LIMITED`, `SUBSCRIPTION_LIMIT`, `UNAUTHORIZED` and `UNAVAILABLE`.
`LOCATION_REJECTED` deliberately combines unavailable assignment, terminal status,
stale/order conflicts and write throttling. Send samples at a sensible interval;
never automatically replay a queue of old samples.

## Session and permission changes

Every handled event rechecks its session. Every broadcast rechecks all intended
recipients' current session and shipment access in batches of 100. Invalidated
memberships are removed before delivery. Role or assignment changes therefore do
not leave a room membership as sufficient authority. Checks use PostgreSQL state,
not an authorization cache.

Idle connections are rechecked on a non-overlapping 15-second interval, in batches
of 100. Revoked, expired, disabled, deleted or credential-invalidated sessions are
disconnected on the next completed check. Actual latency includes database and
batch-processing time; it is not a hard 15-second service guarantee. Tracking's
Neon requests have a five-second fetch timeout, and dependency failures disconnect
connections rather than allowing stale authorization. An already authorized
in-flight operation may finish after revocation or reassignment.

Connection-state recovery is disabled. A reconnect must perform authentication
again and explicitly rejoin authorized shipments. After access-token expiry, use
the normal HTTP refresh flow, update `socket.auth.token`, reconnect and rejoin.
Server-initiated disconnections require client action. Keep HTTP refresh requests
serialized as documented in sessions.md. Backend work does not add this behavior
to the frontend.

## Bounds and deployment limits

- Maximum transport message: 8 KiB.
- Maximum five connections per user per process.
- Maximum ten handled events per second per socket, including rejected/busy work.
- One in-flight event per socket, avoiding an unbounded database-work queue.
- Maximum 20 shipment subscriptions per socket.
- Audience lookup visits only that shipment's local room, not every connection.
- Expiry/revocation checks and audiences use batches of at most 100 identities.

These controls are defense in depth, not a substitute for proxy connection limits,
edge handshake throttling, distributed abuse protection or load testing. Account
connection limits and packet budgets are process-local; persistent GPS write
frequency is enforced in PostgreSQL. The current in-memory adapter serves one
application instance. Multiple instances need a tested shared adapter, compatible
load-balancer configuration and distributed budgets before horizontal deployment.
No multi-instance delivery or million-user capacity is claimed.

Public HTTP tracking now returns null for both shipment and driver live GPS,
preserving the existing response fields. Public status, addresses, driver display
details and events remain; broader public-link privacy, retention and abuse policy
still need a separate review.

No new production dependencies, environment secrets or migrations are required
beyond the session migration `0005`. `socket.io-client` is a test-only dependency.
Apply existing migrations before deploying. Frontend clients must adopt the new
authentication/reconnect contract before using the secured socket server.

## Evidence

`npm run test:integration` includes real Socket.IO clients over loopback WebSocket
and polling plus a separate disposable PostgreSQL 17 container with the application
migrations. It executes production handlers, server options, JWT verification and
SQL with a psql adapter. It does not import the server entrypoint, start notification
workers or use application credentials. The suite covers anonymous/expired/revoked
credentials, cross-business access, forged identity fields, assigned-driver writes,
malformed/stale samples, reassignment, logout, expiry, reconnect, outages, concurrent
writes, packet bursts, origins, oversized frames and live credential invalidation.

Fast tests cover payload bounds and the public GPS projection. Reports are retained
through the existing CI runner. Deployed Bun networking, actual Neon HTTP, frontend
reconnect behavior, load/capacity, distributed delivery and remote GitHub Actions
execution still require evidence. No provider network or production database was
used in these tests.

The connection/authentication design uses Socket.IO's official
[middleware](https://socket.io/docs/v4/middlewares/),
[server-options](https://socket.io/docs/v4/server-options/) and
[client API](https://socket.io/docs/v4/client-api/) contracts.

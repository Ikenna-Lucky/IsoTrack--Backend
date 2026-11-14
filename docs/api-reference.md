# Swagger API reference

The OpenAPI contract covers this branch's 54 application HTTP operations and five
operational endpoints. Use it to implement the frontend without reading backend
handlers. It documents current behavior, including limitations; it does not imply
the older public deployment implements this branch's contract.

## Open the reference

After installing locked dependencies, run from the backend repository:

```sh
bun run docs:serve
```

Open **http://127.0.0.1:8001/docs/**. This read-only preview needs no database,
Redis or secrets; API execution is disabled. An optional positional port is
supported: `bun run docs:serve 8002`.

For interactive calls, start the configured backend with `bun run dev` and open
**http://localhost:8000/docs/** (or the configured backend origin/port). The full
service still needs its documented environment and dependencies. Swagger assets
are served locally, without a CDN or online validator. Production builds include
the assets and their license notices.

The backend also serves **GET /openapi.json**. Import the checked-in
[openapi.json](openapi.json) into Postman, Swagger Editor or a client generator.
When importing the file, set its server to your backend origin; paths already
contain `/api/v1`. Generated clients still need the browser session/retry behavior
below. Swagger includes field types, required/nullable fields, request/response
examples, roles, errors, pagination and headers. Example IDs/accounts/tokens are
synthetic and are not usable credentials.

## Authentication

Login/register return `data.user` and `data.accessToken`, and set the HttpOnly
`iso_refresh_token` cookie. Invitation acceptance returns membership only; a new
driver signs in afterward. Send access tokens as `Authorization: Bearer <token>`.
Swagger's **Authorize** dialog takes the token alone, without `Bearer`.

Use browser `credentials: 'include'` for login/refresh/logout. Keep access tokens
in memory; JavaScript cannot read the refresh cookie. Refresh/logout require
the exact configured frontend `Origin`. Browsers set this header and forbid
overriding it: backend-hosted Swagger normally cannot execute the frontend cookie
flow. Test it from the configured frontend or use curl with the trusted Origin
and a cookie jar. Do not relax the backend check to make Swagger work.

Serialize refresh requests across requests/tabs. Reusing a rotated generation
revokes its session. Failed/lost refresh requires returning to login; avoid
infinite 401 loops. There is no `GET /auth/me`: use the user from login/refresh
and role-specific profiles. Production cross-site cookies also depend on browser
third-party-cookie policy; test the actual deployed domains.

## Workflow decisions for the frontend

| Workflow      | Sequence / limitation                                                                                                                                                                           |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fleet         | Owner creates an invitation and privately shares its one-time token. New driver accepts then signs in; eligible unlinked driver uses accept-existing. Public driver registration returns 403.   |
| Creation      | Owner supplies package, addresses and integer `priceKobo` (100 kobo = NGN 1). Optional linked customer account is independent of `recipientEmail`. No guest account is created.                 |
| Assignment    | From pending, owner assigns an active same-fleet driver. Available-driver discovery is a filter; the command does not enforce availability status.                                              |
| Progression   | Owner/assigned driver advances assigned → picked_up → in_transit → out_for_delivery. Owner may cancel pending/assigned shipments.                                                               |
| Handover      | Owner issues recipient code; use returned challenge/version. Assigned driver reads metadata and confirms with recipient's eight-character code. Status updates cannot bypass confirmation.      |
| Exceptions    | Use exceptions endpoint for failure, retry and return custody. Owner must resolve held-package custody before retry; maximum three total attempts. Return state is separate from failed status. |
| Payment       | Initialize sandbox checkout, preserve reference, redirect, then verify. Inspect `applied` and `requiresReview`, not just `paid`. Checkout cancellation is not a refund.                         |
| Notifications | Cursor-page own records. Read-all changes at most 500 records; repeat while `hasMore`. Preferences do not establish that every channel/event exists.                                            |

Checkout currently redirects both business/customer callers to
`/customer/shipments`; frontend integration must account for that existing
behavior. Analytics `totalRevenueKobo` sums all shipment prices, not settled
payments or driver earnings. Payouts, general refunds, uploads, public fleet
discovery, arbitrary shipment edits and permanent account deletion are absent.

## Retries, conflicts and pagination

- Where required, generate one `Idempotency-Key` per logical action. Preserve the
  same key AND body for uncertain retries. UUIDs fit the required 16–128 ASCII
  letters/digits/hyphen/underscore format. Do not create replacement keys merely
  because a network request timed out. Expired keys remain unusable; reconcile.
- Use current `shipment.version` as `expectedVersion`. On
  `SHIPMENT_VERSION_CONFLICT`, reload and reassess. A changed command is a new
  action with a fresh key. Recipient changes may advance version; use the version
  returned by delivery-code issuance.
- Delivery guesses are also idempotent. Replaying a wrong guess does not consume
  another attempt; a newly entered code requires a new key. Never log/persist codes.
- Cursor lists use `limit` (1–50, default 20), `cursor` and return
  `{limit,hasMore,nextCursor}`. Preserve the cursor; reset on account, endpoint or
  filter changes. Page/offset/search/status parameters are not implemented. Only
  driver shipment lists accept `includeCompleted`.
- Exception history uses `beforeVersion` / `nextBeforeVersion` instead of cursor.
- Respect `Retry-After` on 429/503. Use `X-Request-Id` for support. Some legacy
  validation errors contain Zod objects instead of string codes; role guards may
  return `INTERNAL_SERVER_ERROR` at HTTP 403. Follow the documented HTTP status and
  operation-specific codes instead of assuming a universal error body.

## Socket.IO tracking

OpenAPI covers HTTP, not Socket.IO events. Connect to the same backend origin at
the standard `/socket.io` path with `auth: {token: accessToken}`. Anonymous
recipients use minimal public HTTP tracking and cannot subscribe to precise GPS.

| Direction            | Event             | Payload / result                                                                                          |
| -------------------- | ----------------- | --------------------------------------------------------------------------------------------------------- |
| Client → server      | `shipment:join`   | Tracking ID string, not an object. Ack `{ok:true}` or `{ok:false,code}`. Participant access is rechecked. |
| Server → client      | `shipment:joined` | `{trackingId}` after successful join.                                                                     |
| Client → server      | `shipment:leave`  | Tracking ID string; same ack format.                                                                      |
| Driver → server      | `driver:location` | `{trackingId,lat,lng,timestamp,heading?,speed?}`; current assigned fleet driver only.                     |
| Server → participant | `driver:location` | Accepted payload, omitted heading/speed default to zero. Volatile delivery; no guaranteed history/replay. |

Latitude: -90..90, longitude: -180..180, finite numbers. Timestamp: nonnegative safe
integer Unix **milliseconds**, within 30 seconds behind or 5 seconds ahead of
server time. Optional heading: 0 inclusive to 360 exclusive; speed: 0..100.
Unknown payload fields are rejected. Tracking IDs are 1–64 ASCII
letters/digits/hyphen/underscore; use the exact returned value.

Error codes: `UNAUTHORIZED`, `FORBIDDEN`, `INVALID_PAYLOAD`, `RATE_LIMITED`, `BUSY`,
`SUBSCRIPTION_LIMIT`, `LOCATION_REJECTED`, `UNAVAILABLE`. Limits: five connections
per user, 20 subscriptions/socket, ten event requests/second, one in-flight event
operation/socket. Handle connection failures and acknowledgements. Reconnect with
the new token after refresh; access/session checks can disconnect clients. Do not
present stale coordinates as current after tracking disconnects.

## Maintain the contract

Update `src/openapi/document.ts` and `src/openapi/schemas.ts` with route changes:

```sh
bun run docs:generate
bun run docs:check
bun run test:unit
bun run type-check
bun run lint
bun run build
```

CI validates OpenAPI and rejects stale exports. Contract tests compare the route
inventory, selected production validators and handler responses, validate examples,
and exercise local Swagger serving. These checks reduce drift; they do not prove
every response in every deployed environment. Database/provider integration suites
remain separate evidence.


## Business notification preferences

`GET/PATCH /business/notifications` controls owner email for shipmentCreated,
driverAssigned, pickedUp, outForDelivery, delivered and failed. Defaults enable
all of these except pickedUp. Supply both email/sms booleans for each changed
event; PATCH merges event objects at the top level and may return partial JSON.
SMS, driverOnline and weeklyReport are stored compatibility fields, without
implemented delivery. In-app notifications remain available regardless of email
choices. Recovery, verification, recipient delivery-code and customer notification
flows have separate policies.

When the notification worker completes a new Business in-app shipment event, it
atomically records the eligible email job. Dispatch checks current ownership,
recipient activity and email preference again, so opting out suppresses queued
or retried mail. Email already being sent cannot be recalled. Completed historical
in-app events are not backfilled. The worker, Redis and configured mail transport
must be running for asynchronous delivery. No additional database migration is
needed for this change.


## Driver notification preferences

The existing GET/PATCH `/drivers/me/notifications` endpoints now govern three
shipment events: newDelivery (assigned), deliveryComplete (confirmed handover)
and deliveryFailed (an actual recorded failure). `push` is the legacy API field
for the dashboard inbox; it does not register browser or device push. In-app and
email delivery are independent. Defaults enable both for these three events.
Other event fields remain stored for compatibility without delivery support.
PATCH atomically merges changed event pairs into stored JSON so unrelated choices
survive concurrent edits; supply both booleans for each changed pair. Concurrent
changes to the same event still use the last committed pair.

Migration `0018_driver_notifications.sql` captures two durable channel candidates
with each supported event. Failure capture follows the structured exception
record so return audit entries do not send repeated failed-attempt alerts.
Workers recheck preferences, current assignment, fleet membership and active
recipient status before dispatch. Opted-out candidates become skipped, existing
inbox records remain, and email already sending cannot be recalled. No historical
backfill is performed. Email links open `/driver/deliveries`.

Apply `bun run db:migrate` before running the updated worker. Delivery requires
Redis, NOTIFICATION_WORKERS_ENABLED=true and the existing configured mail
transport. The currently checked local environment has workers disabled; it has
not been changed to send external emails. Migration 0018 was applied locally.
Disposable PostgreSQL and a local SMTP catcher verified delivery without sending
real mail. No HTTP endpoint was added; Swagger descriptions and export updated.

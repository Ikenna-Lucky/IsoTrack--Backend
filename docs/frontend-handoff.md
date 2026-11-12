# Frontend integration contract

Use [Swagger and the API integration guide](api-reference.md) and the
[OpenAPI contract](openapi.json) for HTTP fields, responses and examples.
This handoff adds workflow context; ordinary frontend integration should not
require reading backend source.

This document describes the updated backend candidate, not the older main
deployment. Do not connect a new client to main and assume these contracts are
deployed. Apply migrations through 0017 and promote/test the candidate on preview
before browser acceptance. Source schemas and the linked domain documents define
the detailed fields; this document is the integration entry point.

## Transport and errors

- API base: configured backend origin plus `/api/v1`; no hardcoded environment URL
  in components. Use HTTPS for a deployed browser client.
- JSON successes normally contain `{success:true,data:...}` with optional message.
  HTTP status determines success; some mutation responses have `data:null`.
- Errors contain `success:false`; domain handlers normally return a string `error`
  and optional `message`. Schema-validation handlers can return an error object
  with issues. Do not assume every `error` is a string or display raw objects.
  Client HTTP exceptions now also return JSON rather than plain text.
- 400 invalid input; 401 invalid/expired/revoked session or invalid credentials;
  403 forbidden role/origin; 404 absent/inaccessible resource; 409 stale state,
  key mismatch or unmet precondition; 413 body too large; 422 unsupported workflow;
  429 throttling; 5xx dependency/server failure. Honor Retry-After when present.
- Capture X-Request-Id and status for support, without logging passwords, access
  tokens, refresh cookies, invitation tokens, recipient codes or sensitive bodies.
- Do not blindly retry writes with a new key after a timeout or server error.

## Identity and session state

| Method/path                       | Input                                                                             | Result / behavior                                                             |
| --------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| POST `/auth/register`             | name, email, password, role=`business` or `customer`; optional phone/businessName | 201 user/accessToken, refresh cookie; business profile is created atomically. |
| POST `/auth/login`                | email, password                                                                   | user/accessToken and HTTP-only refresh cookie.                                |
| POST `/auth/refresh`              | Refresh cookie; exact trusted Origin                                              | New accessToken/user and rotated refresh cookie.                              |
| POST `/auth/logout`               | Refresh cookie; exact trusted Origin                                              | Revokes identified session and clears cookie; missing cookie is idempotent.   |
| PATCH `/auth/me`                  | Supported name/phone/avatar/emergencyContact fields                               | Updated safe user record.                                                     |
| PATCH `/auth/password`            | currentPassword, newPassword                                                      | Invalidates sessions; return to login.                                        |
| POST `/auth/deactivate`           | currentPassword; Bearer access token                                              | `{isActive:false}`; sessions/actions become invalid, records preserved.       |
| DELETE `/auth/me`                 | Bearer token                                                                      | 409 PERMANENT_DELETION_UNAVAILABLE; no permanent delete.                      |
| POST `/auth/forgot-password`      | email                                                                             | Generic response; do not infer account existence.                             |
| POST `/auth/reset-password`       | token, newPassword                                                                | Consumes recovery link and invalidates sessions.                              |
| POST `/auth/verification/request` | email                                                                             | Generic response; sending depends on worker/provider configuration.           |
| POST `/auth/verification/confirm` | token                                                                             | Consumes verification link for current identity/credentials.                  |

Passwords for signup/change/reset require 8–72 characters, an uppercase character
and a digit, with a maximum of 72 UTF-8 bytes. Deactivation verifies the current
password and enforces the same byte ceiling before bcrypt. It does not delete
data, transfer a fleet or offer public reactivation. See [deactivation](account-deactivation.md).

For cookie endpoints, browser fetch must include credentials; trusted Origin is
set by the browser and must match FRONTEND_URL. Production cookies are Secure and
SameSite=None. Browser third-party cookie restrictions still require browser
testing with the selected frontend/backend domains. There is no GET `/auth/me`;
use the safe user returned by login/refresh, then role-specific profile endpoints.

Serialize refresh across concurrent requests and tabs. A reused refresh generation
revokes its session: there is no grace period. On lost refresh acknowledgement,
revocation or failed refresh, clear client auth state and return to login. Do not
run an infinite 401-refresh loop. Disconnect/reconnect sockets when identity or
access token changes. See [sessions](sessions.md).

## Fleet enrollment and profiles

| Method/path                                | Actor                     | Input / result                                                                                              |
| ------------------------------------------ | ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| POST `/driver-invitations`                 | Business owner            | `{email}`; 201 invitation/token, returned only once. Share privately.                                       |
| GET `/driver-invitations`                  | Business owner            | Latest 50 owned invitations, without token hashes.                                                          |
| DELETE `/driver-invitations/:id`           | Business owner            | Revokes pending invitation.                                                                                 |
| POST `/driver-invitations/accept`          | Named recipient           | token, email, name, password, vehicleType, vehiclePlate; 201 membership. Then sign in.                      |
| POST `/driver-invitations/accept-existing` | Signed-in unlinked driver | `{token}`; no account ID supplied by client.                                                                |
| GET `/drivers`, `/drivers/available`       | Business owner            | Cursor page of own fleet; available filter is a separate cursor scope.                                      |
| GET/PATCH `/drivers/me`                    | Driver                    | Own profile / supported vehicle fields.                                                                     |
| GET/PATCH `/drivers/me/notifications`      | Driver                    | Stored preferences; not a promise every displayed channel is implemented.                                   |
| PATCH `/drivers/me/status`                 | Driver                    | status=`available`, `on_delivery` or `offline`; membership required to go online.                           |
| PATCH `/drivers/me/location`               | Driver                    | `{lat,lng}` only, finite geographic bounds; updates profile location, not shipment tracking.                |
| GET `/drivers/:id`                         | Business owner            | Own fleet member detail; foreign/missing both 404.                                                          |
| GET/PATCH `/business/profile`              | Business owner            | Business profile/name/address. Missing or ambiguous legacy profiles return 409 for operator reconciliation. |
| GET/PATCH `/business/preferences`          | Business owner            | UI preferences, atomic top-level partial merge. Payment currency is still NGN.                              |
| GET/PATCH `/business/notifications`        | Business owner            | Atomic top-level preference merge; see actual supported delivery channels.                                  |
| GET `/business/analytics`                  | Business owner            | Scoped shipment aggregates, not a financial settlement ledger.                                              |

Public registration with role=driver is denied. A driver belongs to one business
at a time; fleet transfers and autonomous removal of historical memberships are
not public endpoints. Do not build a public driver directory or transfer button.

## Pagination

Shipments, shipment events, drivers, available drivers and notifications use
`limit` (default 20, 1–50) and opaque `cursor` where applicable:

```json
{
  "success": true,
  "data": [],
  "pagination": { "limit": 20, "hasMore": false, "nextCursor": null }
}
```

Preserve the returned cursor exactly; append or replace data intentionally. Never
reuse it across account, endpoint or filter changes, and do not construct offsets
from it. Unknown/duplicate pagination parameters are rejected. Pages are ordered
by newest creation timestamp and ID; ties preserve database microseconds.
Default driver shipment pages omit completed work but retain failed packages in
custody. Drivers can request includeCompleted=true on shipment lists only.

Exceptions use a different cursor: beforeVersion / nextBeforeVersion. Invitation
lists are capped latest-50 views, not cursor pages. Do not assume all arrays contain
the complete history or all fleet members.

## Shipment workflow and replay

| Method/path                            | Required body / query                                                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| GET `/shipments`                       | limit/cursor; driver-only optional includeCompleted.                                                                                  |
| GET `/shipments/:id`                   | Owner, linked customer or current same-fleet assigned driver.                                                                         |
| GET `/shipments/:id/events`            | limit/cursor; scoped event history.                                                                                                   |
| POST `/shipments`                      | description, weightKg, pickupAddress, deliveryAddress, priceKobo; optional customerId/customerEmail, scheduledPickup, recipientEmail. |
| PATCH `/shipments/:id/assign`          | driverId, expectedVersion.                                                                                                            |
| PATCH `/shipments/:id/status`          | status, expectedVersion, optional note; workflow/role rules still apply.                                                              |
| DELETE `/shipments/:id`                | expectedVersion; means cancellation, not record erasure.                                                                              |
| GET `/shipments/:id/exceptions`        | limit/beforeVersion; business/assigned driver only.                                                                                   |
| POST `/shipments/:id/exceptions`       | action, expectedVersion; fail also requires reason and optional note.                                                                 |
| POST `/shipments/:id/delivery-code`    | expectedVersion, recipientEmail; business only.                                                                                       |
| GET `/shipments/:id/delivery-code`     | Business/assigned driver; metadata, never plaintext code.                                                                             |
| POST `/shipments/:id/confirm-delivery` | expectedVersion, challengeId, 8-character decimal code; assigned driver only.                                                         |

Shipment creation, assignment/status/cancellation, exceptions, delivery issuance/
confirmation and checkout initialization require Idempotency-Key (16–128 allowed
characters; generate a random UUID once for each intended action). Retain key and
exact body until outcome is known. Same key/body replays the saved response with
Idempotency-Replayed=true. Changed input requires a new logical action and key;
never reuse an expired key. On SHIPMENT_VERSION_CONFLICT, reload before deciding
the next action. Do not silently resubmit a different expectedVersion under an
old key. Do not put passwords or delivery codes into a persisted retry queue.

Addresses require street/city/state strings. Prices are integer kobo, not naira
floats (250000 means NGN 2500). Shipment identifiers are opaque. Use camelCase API
fields; SQL column names are not client contracts.

Ordinary status changes cannot complete delivery: use recipient proof. Failed
deliveries use the exception actions fail/retry/return_request/return_start/
return_receive/cancel_failed, with the role and custody rules in
[exceptions](shipment-exceptions.md). Never clear assignment, pickup or custody
locally to bypass a rejected transition. See [commands](shipment-commands.md),
[proof](delivery-confirmation.md) and [idempotency](idempotency.md).

## Payments and return routes

- POST `/payments/initialize`: Bearer business/customer token, Idempotency-Key and
  `{shipmentId}`. Redirect to data.authorizationUrl from the response.
- GET `/payments/verify/:reference`: owning business/linked customer only. Reads
  Stripe and reconciles; this is not a harmless polling endpoint to call rapidly.
- POST `/payments/:reference/cancel`: verifies expiry/cancellation with Stripe;
  a closed browser tab or return URL does not itself cancel a payment.
- POST `/payments/webhook`: provider-only signed raw callback; never call it from
  the frontend. Do not send the user's Bearer token or fake a successful callback.
- On the configured success/cancel return page, use payment_reference to verify
  the authorized record. Provider `paid` and local `applied` are different:
  use applied=true for accepted shipment payment; requiresReview means display a
  review state instead of promising fulfillment.
- Shipment detail includes the latest local payment projection for authorized
  business/customer views; drivers do not receive it. No public full financial
  ledger, normal paid-shipment refund, payout or dispute endpoint is supplied.
- Keep all Stripe secret keys and signing secrets on the backend. This hosted
  Checkout flow needs no publishable key in the browser. Sandbox only.

The existing preview return URL can point at the backend and return 404 until the
frontend routes are deployed/configured. That response is not proof a payment
failed. Read [payments](payments.md) for recovery and provider setup.

## Tracking and notifications

Public GET `/track/:trackingId` exposes limited status/dates/safe events, not
addresses, recipient details, raw messages or live GPS. The tracking ID is not a
socket credential. Keep the public view separate from authenticated detail.

Connect Socket.IO with `auth:{token:accessToken}`, trusted browser Origin and
acknowledgements. Join/leave uses shipment:join/shipment:leave with a tracking ID
string. Only assigned drivers emit driver:location with trackingId, lat, lng,
timestamp in Unix milliseconds and optional heading/speed. Rejoin after reconnect;
do not replay a queue of old GPS samples. Volatile delivery can drop updates:
refetch authorized detail for persisted state. See [socket contract](tracking.md).

Notifications: GET `/notifications` is cursor-paginated. PATCH
`/notifications/:id/read` atomically marks only an owned notification; DELETE
`/notifications/:id` deletes only an owned notification. Foreign/missing IDs both
return 404. PATCH `/notifications/read-all` processes at most 500 rows and returns
`{updated,hasMore}`. If continuing, use bounded client work with cancellation and
backoff; do not assume one request always marks every historical notification.
Unsupported SMS/push/marketing controls must not be presented as working delivery
channels merely because a preference or dependency exists.

## Frontend acceptance sequence

1. Register business/customer; confirm role bootstrap, cookies, serialized refresh
   and logout against the actual selected frontend/preview domains.
2. Invite/enroll driver; confirm an unrelated business cannot see or assign them.
3. Create and page shipments; assign, advance versions and replay one uncertain
   action without duplicate workflow events.
4. Exercise sandbox payment success, cancel and review display using applied state.
5. Track through an authorized socket, reconnect with a new token, and verify the
   public tracking view reveals only permitted fields.
6. Issue recipient proof and confirm delivery; exercise failed delivery/return
   states without losing custody.
7. Render pagination, 401/403/404/409/429/dependency failures, no-data/loading states,
   notification continuation and deactivation blockers explicitly.

These browser acceptance checks are frontend work. The backend closeout register
must identify the candidate, local/remote evidence and remaining release risks
before this document is described as a completed integration handoff.

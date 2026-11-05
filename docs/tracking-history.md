# Public tracking and authenticated shipment history

## Public tracking contract

`GET /api/v1/track/:trackingId` is anonymous. Possessing a tracking ID allows a
person to see status; it does not prove they are the recipient. The response is
therefore deliberately small:

```json
{
  "success": true,
  "data": {
    "trackingId": "IST-EXAMPLE",
    "status": "in_transit",
    "scheduledPickup": null,
    "estimatedDelivery": null,
    "actualDelivery": null,
    "events": [
      {
        "status": "picked_up",
        "createdAt": "2026-11-05T12:00:00+00:00",
        "message": "Shipment picked up"
      }
    ],
    "eventsTruncated": false
  }
}
```

There are no addresses, package description, account/driver identity, vehicle
plate, GPS, recipient email, payment details or internal shipment/event IDs.
Messages come from a fixed status-to-message mapping, never event free text.
Only status/time are selected from the newest 21 events; at most 20 are returned.
The extra event sets eventsTruncated without counting the full history. The SQL
does not load account/driver relations or private shipment JSON.

The route accepts 1–64 ASCII letters, numbers, underscores and hyphens, normalizes
case to uppercase before an indexed equality lookup, and rejects query parameters.
Malformed requests return 400; unknown links return 404. It sets Cache-Control:
no-store and X-Robots-Tag: noindex, nofollow, including route-level errors. These
headers are not authentication or a guarantee that a third party cannot copy a
link. This build does not add link expiration/rotation or distributed public-read
rate limits; hosting/abuse controls remain deployment work.

This replaces the earlier public response, which included addresses, a driver
profile, package description and raw event locations/messages. Frontend work must
adopt the reduced contract before promotion to main. No frontend was changed and
the existing main deployment is unaffected by these development-branch edits.

## Authenticated history contract

```text
GET /api/v1/shipments/:id/events?limit=20
GET /api/v1/shipments/:id/events?limit=20&cursor=<nextCursor>
```

Use a valid Bearer access token and live session. Business owners can read their
shipments, customers their linked shipments, and drivers their assigned shipments
within their current private fleet. Every page rechecks active account, current
role and ownership/assignment in the same SQL statement as the event selection.
Changing assignment, ownership, role or session validity can end access mid-page.
An authorized shipment with no events returns an empty 200 page; missing and
foreign shipments return the same 404 response.

The response is `{ success, data: [...], pagination: { limit, hasMore, nextCursor } }`.
Each event contains only id, shipmentId, status, message, location and createdAt.
The richer messages/GPS are available only to authorized actors; retention may
already have cleared old location fields. Default limit is 20, maximum 50.
Only limit and cursor parameters are supported, without duplicates. Invalid
limits, malformed/oversized cursors or mismatched cursor scope return 400
INVALID_PAGINATION. There is no total count or arbitrary page number.

Follow nextCursor until null to retrieve history older than the detail endpoint's
50-event preview. Start at the history endpoint rather than constructing a cursor
from the detail JSON; cursor times preserve PostgreSQL microseconds. Cursors are
bound to endpoint, shipment, account and role. They are opaque client values, not
encrypted/signed credentials; SQL authorization remains authoritative even for a
caller who constructs a valid position. Existing shipment-list cursors retain
their previous format and cannot be reused for event pages.

Ordering is descending `(created_at, id COLLATE "C")`, using the existing
shipment_events_page_idx from migration 0012. Each query seeks below the last
returned position and reads at most limit+1 events. It does not need the boundary
row to still exist. New events above the cursor do not shift subsequent pages.
Pages use live database snapshots rather than one frozen export: older backdated
inserts may appear, deleted records disappear, and administrative timestamp/ID
edits are outside this ordering guarantee. Bounded event counts do not establish
a byte ceiling for arbitrarily large legacy event messages/JSON.

No new migrations, secrets or GitHub Action allowlist entries are required. The
test runner discovers tracking-history.integration.mjs automatically. Local HTTP,
signed JWT/session, PostgreSQL and query-plan evidence is recorded in
production-readiness.md. Hosted Neon transport, deployed frontend behavior,
large concurrent traffic and public-read abuse protection are not established by
these tests.

# Shipment list pagination

Recipient email is exposed only in business responses. Drivers/customers and
public tracking do not receive that field; see delivery-confirmation.md.

`GET /api/v1/shipments` now returns cursor pages for businesses, drivers and
customers. Default `limit` is 20, maximum 50. Follow `pagination.nextCursor` with
the same account and filter until it is null:

```text
GET /api/v1/shipments?limit=20
GET /api/v1/shipments?limit=20&cursor=<nextCursor>
```

The response is `{ success: true, data: [...], pagination: { limit, hasMore,
nextCursor } }`. There is no total/count, page number, totalPages or arbitrary
page jump. Missing profiles or no matching shipments produce an empty successful
page. Results are not cached (`Cache-Control: no-store`). Drivers can opt into
terminal history using `includeCompleted=true`; their default excludes delivered,
and cancelled shipments, and failed shipments whose packages are not in custody.
Failed packages held by the driver remain visible until return receipt (migration
0014). Other roles cannot supply this filter.

Limits must be decimal integers 1–50. Unknown parameters (including legacy
`page`/`pageSize`), duplicates, malformed/oversized cursors and invalid filter values
return 400 `INVALID_PAGINATION`. Changing the limit between pages is allowed;
changing account, role or completion filter requires restarting without a cursor.
The cursor carries a version, scope digest, exact UTC timestamp and ID. It is
bounded to 1,024 URL-safe characters and validated before executing list SQL.
Treat it as opaque, not encrypted or signed. Its digest detects scope mismatch;
it is not an authorization credential. Even a forged position stays subject to
the current database identity, ownership, customer or private-fleet predicates.

Ordering is descending `(created_at, id COLLATE "C")` for every role. Creation
times retain PostgreSQL microsecond precision in cursor boundaries, without a
JavaScript Date round trip. ID breaks timestamp ties. Driver ordering changes from
recently updated to recently created: GPS/status changes cannot move old records
between pages. The next query seeks strictly below the last returned position;
it does not need that boundary row to still exist. Newer concurrent inserts do
not shift subsequent pages or duplicate previously returned rows.

This is a live list, not a frozen snapshot across requests. Backdated inserts can
appear later; deleted, reassigned or completed records can disappear. Restart to
see newly created records above the cursor. Administrative changes to creation
times/IDs are outside the stable-order contract. Every page rechecks current
ownership/membership and active database identity. A business account uses its
first business profile by ID, matching the existing single-profile product model;
multiple-profile business selection is not implemented.

## Bounded query and response work

The materialized base query selects at most `limit + 1` shipments. The extra row
determines `hasMore`, then is discarded. There is no OFFSET or COUNT query.
Contact lookups and event subqueries run only for those selected rows. Driver
pages include at most one recent event per shipment; customer pages include at
most three; business pages include no event history (an empty `events` array).
For full history use the detail endpoint, whose history pagination is separate
remaining work. Bounded rows do not guarantee a byte ceiling for legacy JSON data.

Account contacts expose only ID, name, email, phone and avatar. The driver
relation now exposes ID, vehicle type/plate and approved user contact fields.
It excludes driver insurance, preferences, private profile fields and driver GPS.
Shipment fields retain their existing authorized response projection and include
the workflow version. Event field names remain camelCase.

Migration 0012 adds business/customer composite scope/order indexes, driver
scope/order indexes for full and active history, and an event scope/order index.
They use the same collation and ordering as the seek predicates. Apply through
the production migration runner before serving the new list path. Normal index
creation participates in the migration transaction; lock/build duration and disk
space need rehearsal at deployment scale. This is not an online index rollout
claim, and no production migration was performed. Old indexes are retained.

Coordinate frontend adoption of `limit`/`nextCursor`, removed totals and the
reduced driver relation. Continuing to request a numbered page fails explicitly
rather than silently returning an unexpected page. Frontend files are unchanged.
No new secrets, paid service or infrastructure are required.

## Verification boundaries

Two fast cases cover strict limits and cursor parsing, timestamp validation,
microseconds and scope/filter binding. Seven integration cases use real loopback
HTTP, production JWT/session middleware, migrated PostgreSQL 17 and the production
list statement. The fixture replaces Neon transport with psql, not SQL semantics.
Cases cover all-role traversal/ties, tenant denial, concurrency/deleted boundaries,
microseconds, driver filters/reassignment, private fields, bounded histories and
server errors. Plan checks seed 10,000 batch-import shipments sharing a timestamp
and seek a deep ID boundary. All four scope/filter plans must use the composite
indexes, avoid shipment sequential scans and read at most 21 shipment rows for a
20-row page. Plans are retained under reports/shipment-page-plan-\*.json.

These measurements demonstrate local query behavior on a particular small dataset,
not sustained concurrency, million-user capacity or hosted latency. Hosted Neon,
full Bun/ingress/browser adoption, varied tenant distributions, large legacy
payloads and load/overload testing remain release gates. Execution results and
retained failure/recheck evidence are in docs/production-readiness.md.

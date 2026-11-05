# Shipment read contracts

Authenticated detail and business analytics use explicit SQL projections. Adding
a table column does not add it to either response. Authentication still verifies
the signed access token, live session and current account; each read statement
also checks the current active role and shipment ownership/assignment.

| Response data                                                                    | Owning business                | Assigned driver in that fleet | Linked customer        |
| -------------------------------------------------------------------------------- | ------------------------------ | ----------------------------- | ---------------------- |
| Shipment package, addresses, workflow/version, price, paid flag and shipment GPS | Yes                            | Yes                           | Yes                    |
| Recipient email used for delivery codes                                          | Yes                            | Omitted                       | Omitted                |
| Customer and driver account contact                                              | ID, name, email, phone, avatar | Same                          | Same                   |
| Driver profile                                                                   | ID, vehicle type and plate     | Same                          | Same                   |
| Payment                                                                          | Latest attempt summary         | Null                          | Latest attempt summary |
| Events                                                                           | Latest 50                      | Latest 50                     | Latest 50              |
| Business analytics                                                               | Own business only              | Forbidden                     | Forbidden              |

Driver insurance, notification preferences and driver-profile GPS are excluded.
Account passwords, credential generations, emergency contacts and account flags
are excluded. Payment summaries contain only ID, amountKobo, status, channel,
paidAt and createdAt; provider references, Stripe IDs, leases, review reasons,
refund identifiers and operator identity are excluded. The shipment's isPaid flag
remains the settlement indicator; a summary describes the latest payment attempt,
ordered by creation time then ID, and is not a reconciliation report.

Details return the latest 50 events with deterministic time/ID ordering.
`eventsTruncated=true` explicitly signals omitted older history. Events are not
deleted. There is no older-history HTTP page endpoint yet; this is a deliberate
development-branch contract change that frontend adoption must handle. No deployed
frontend compatibility has been verified. Missing and foreign IDs both return 404.
Successful/route-level denied responses use Cache-Control: no-store.

Analytics reads counts, price sums and the ten most recent shipments in a single
PostgreSQL statement/snapshot. Request-supplied business IDs cannot change scope.
A business account without a profile receives empty analytics without creating
data during GET. Recent shipments use the same contact and shipment projection as
details, with no event or payment graph. The legacy `totalRevenueKobo` name is
preserved: it sums quoted shipment prices, including unpaid/cancelled shipments;
it is **not settled revenue**. Integer totals exceeding JavaScript's safe integer
range fail rather than silently round. Exact aggregates still scan that tenant's
shipment rows; rollups/caching and hosted load measurements remain future work.

## Verification

`tests/shipment-reads.integration.mjs` uses real signed JWTs, production session
checks/router/query builders, a local HTTP server and disposable PostgreSQL 17
with the complete migration journal. Its database adapter uses the existing
Docker/psql fixture, not hosted Neon HTTP. It covers positive role access, foreign
and absent IDs, assignment removal, account/role rechecks, private markers and
exact related-field keys, bounded events, payment ordering/null relations,
tenant analytics, missing profiles, storage faults and a newly added private
database column. The safe-integer handler test supplies synthetic totals; it does
not claim a multi-million-row database test. CI automatically discovers both files.

This scope does not establish privacy of every endpoint, public tracking payloads,
historical idempotency responses, logs, provider dashboards or backups. Public-link
address/event visibility and full history pagination remain separate work.

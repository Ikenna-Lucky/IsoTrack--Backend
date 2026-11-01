# Shipment write consistency

Shipment creation inserts its initial history event in the same PostgreSQL
statement. Status changes, assignment and cancellation update the shipment and
insert their event through dependent data-modifying CTEs. A constraint failure in
either write rolls back the statement. Neon HTTP does not require an interactive
transaction for this operation.

The transition statement checks ownership/assignment again, not just the prior
route lookup. It requires the expected current status. Competing requests against
the same starting status cannot both succeed; a losing request returns HTTP 409
and must reload before retrying. Valid transitions and action roles are enforced
again in the query builder. Assignment requires an active driver in the same
fleet. Retrying a failed shipment clears its old assignment and pickup/delivery
timestamps, avoiding stale operational state on the new attempt.

Raw database JSON is converted back to the existing camelCase shipment response
shape, including timestamp handling. Shipment creation composes a Drizzle insert
fragment into the atomic statement.

## Verification and remaining work

Integration tests execute the production CTEs against PostgreSQL, including a
Drizzle-generated creation insert. They test committed state/history, rollback on
event failure, competing assignment/cancellation, denial without history, fleet
and active-driver checks, and retry cleanup. Full shipment HTTP route coverage and
the deployed Neon transport remain unverified.

This is expected-status concurrency control, not request idempotency or a complete
version history. A status that cycles back can match an older request; durable
idempotency keys and version-aware updates remain release work. Event IDs are
generated per request, not supplied as idempotency keys.

Notifications still happen after commit and can fail independently. Durable
notification dispatch/outbox and recovery remain required. A later dependency
failure may produce an error after the shipment write committed; clients must not
blindly repeat creation. Driver workload limits and delivery proof are separate
business rules. No database migration is required for this batch.

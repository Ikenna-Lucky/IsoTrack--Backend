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

The original helper described above uses expected-status concurrency control.
Public update routes now use durable idempotency and a workflow version instead;
see [shipment commands](shipment-commands.md). The version trigger also advances
for internal helper updates. Event IDs remain server-generated.

The later durable outbox migration captures notices transactionally. Delivery
happens asynchronously and has independent retry/recovery behavior. Creation and
update retries must use their original idempotency key. Driver workload limits,
delivery proof and hosted verification remain separate work. The command build
requires migration 0011; the original helper batch did not require a migration.

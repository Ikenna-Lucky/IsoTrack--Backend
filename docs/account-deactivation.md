# Account deactivation

Apply migration 0016 before deploying this API; 0017 additionally supports the
bounded collections introduced in the same closeout. Main/live are not migrated
by these development changes.

POST `/api/v1/auth/deactivate` requires a valid Bearer session and the current
password as `{currentPassword}`. Shared peer/account request budgets and a 2KiB
body limit precede bcrypt. Unknown fields and passwords beyond 72 UTF-8 bytes
are rejected. A changed password between verification and the database write
produces 409 CREDENTIALS_CHANGED rather than deactivating with stale credentials.

The database function locks the account (and existing driver profile first, matching
profile-write order), checks work using subsequent statements, and changes
is_active=false. The existing credential-version trigger invalidates all sessions
and account-action links without updating an unbounded number of session rows.
Driver availability becomes offline and profile location is cleared in the same
transaction. Successful API response clears the refresh cookie. New login is
denied; changing the user's name/email is not a public reactivation route.

Deactivation preserves the user, membership, shipment/customer links, events,
payments, receipts, refund audit, notifications and idempotency history. It is
not anonymisation, erasure, tenant deletion or a financial-record retention policy.
DELETE `/auth/me` now returns 409 PERMANENT_DELETION_UNAVAILABLE after authentication
and does not delete data. UI must use the explicit deactivation flow and wording.

## Blockers

| Code                       | Required resolution                                                                                                                             |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| FLEET_OFFBOARDING_REQUIRED | A business still has linked driver profiles. Operator-led offboarding is required; no public transfer/removal policy is supplied.               |
| ACTIVE_SHIPMENTS           | Resolve nonterminal shipments or a failed package with pickup but no received return. Applies to business, assigned driver and linked customer. |
| UNRESOLVED_PAYMENTS        | Resolve creating/open/review payments, received money reviews or checkout guards before closure.                                                |
| CREDENTIALS_CHANGED        | Sign in again; do not reuse a previously verified password hash.                                                                                |

Blockers leave the account active and do not remove its work. Business offboarding
must preserve historic assignments; do not clear shipment driver references or
delete fleet members just to make this endpoint succeed. Public fleet transfer,
commercial closure/erasure and automated reactivation remain separate scope.

## Concurrent work

New active shipment writes, fleet enrollment/online transitions and invitation
creation lock participant account rows in stable ID order. Checkout preparation
wraps the existing function with the same account locks; payment callbacks/refund
observation remain able to preserve money records independently of active status.
An inactive account cannot admit new work after closure commits. If already
admitted work commits first, closure waits and then observes its blockers.
Read/HTTP requests already authorized can finish; this is not retroactive recall.

All operations use ordinary application database access, not SECURITY DEFINER.
Existing legacy assignments are not silently reassigned or erased. The historical
fleet FK remains a separately documented validation gate. Operators must validate
it before claiming complete legacy fleet integrity.

## Verification

The full Bun app runs against disposable PostgreSQL/Redis with real HTTP login,
Bearer/session checks and bcrypt. Tests cover wrong/oversized/mismatched input,
preserved history, access/refresh/login denial, active work, failed-return custody,
money-review resolution, fleet blockers, both directions of concurrent creation
versus closure with an observed PostgreSQL lock wait, credential CAS and injected
downstream failure rolling back the whole closure. SMTP/Stripe are disabled;
payment fixtures are SQL test records, not real provider refund verification.

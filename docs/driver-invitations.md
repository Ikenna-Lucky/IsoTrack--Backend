# Driver invitations

## API

All paths are relative to `/api/v1/driver-invitations`.

| Method/path    | Access                 | Behavior                                                                                                                           |
| -------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| POST `/`       | Business owner         | Accepts `{ "email": "driver@example.test" }`; returns invitation metadata and a one-time-display secret token. Valid for 48 hours. |
| GET `/`        | Business owner         | Returns the newest 50 invitations belonging to this business, without token hashes or secrets.                                     |
| DELETE `/:id`  | Issuing business owner | Revokes a pending invitation; foreign, accepted or already revoked IDs return 404.                                                 |
| POST `/accept` | Token holder           | Creates a new driver account and membership atomically; returns 201. Login is a separate request.                                  |

Acceptance body:

For an existing driver, use `POST /accept-existing` while signed in, sending only
`{ "token": "..." }`. The server derives identity and email from trusted account
state. The response is 200 on success or a generic 409 when enrollment is not
available. The body below is for new-account acceptance only.

```json
{
  "token": "the-43-character-token-returned-at-creation",
  "email": "driver@example.test",
  "name": "Driver Name",
  "password": "UseAUniquePassword123",
  "vehicleType": "bike",
  "vehiclePlate": "ABC-123"
}
```

Email is trimmed and lowercased. Passwords are limited to 72 UTF-8 bytes to avoid
bcrypt truncation. Requests are limited to 8 KiB. Responses disable caching.

The owner currently shares the token securely with the named recipient. There is
no automatic invitation email, acceptance UI or generated frontend link. Never
put the token in logs, source control or analytics. Only its SHA-256 hash is stored.
Possessing this token does not establish email verification; accounts retain the
default unverified email state.

## Atomicity and races

The application uses Neon HTTP, which cannot run interactive Drizzle transactions.
Acceptance therefore uses one PostgreSQL statement with a row lock and dependent
data-modifying CTEs. User creation, profile creation, membership and consumption
either succeed together or roll back. The statement rechecks the invitation after
password hashing. Revocation and competing acceptances serialize on its row.

Invitation replay, expiry, revocation and wrong recipient produce no new accounts.
Two invitations for one email compete on the user email uniqueness constraint;
only the successful account creation consumes an invitation. An existing account
is never overwritten, converted to a driver, or transferred to another fleet.

## Deliberate boundaries and release blockers

Existing unlinked drivers can accept while signed in. Already-linked drivers,
inactive users, wrong roles/emails, missing profiles, unavailable invitations and
unreconciled cross-business shipment history cannot enroll. Passwords remain
unchanged, customer/business roles cannot be converted, and transfers are not
supported. Joining resets driver availability to offline. Profile assignment and
invitation consumption are atomic; competing invitations can join only one fleet.

Do not release publicly until distributed abuse controls for issuing/accepting
invitations, HTTP authentication/authorization regression coverage, email
verification, legacy data reconciliation and operational telemetry are complete. The SQL
integration suite proves database invariants, not end-to-end routing, deployed
provider compatibility or delivered emails. Apply migration `0003` before using
the new endpoints. No live application database was migrated during development.
Fast handler tests use controlled identities. The existing-driver integration test
uses the production authentication middleware, real signed JWT verification and
a PostgreSQL user lookup, then executes enrollment SQL and verifies persistence
and replay rejection. The deployed Neon transport and full parent routing remain
separate verification requirements.

# Private fleet foundation

A driver has at most one profile (`drivers.user_id` is unique) and one business
membership (`drivers.business_id`). Business owners can discover and assign only
drivers in their own fleet. Drivers can read shipments only while assignment and
fleet membership both match. Public driver registration returns a denial; account
creation through the invitation acceptance workflow is documented in
`docs/driver-invitations.md`. Existing-account enrollment remains outstanding.

## Migration

Apply `0002_private_fleets` through the migration runner. Do not rewrite the
misdated `0001` journal entry on an existing database. The forward migration
repairs the missing settings fields even if that older migration was skipped.

Before applying it, check for duplicate driver profiles per user. The unique index
deliberately fails rather than silently choosing which profile to retain. Test and
reconcile duplicates on a database copy before an operational migration.

Existing drivers retain a null business membership. Historic assignments are not
reliable evidence of ownership. Such drivers are excluded from business driver
discovery, cannot go online, and cannot read historic deliveries through driver
shipment APIs until explicitly onboarded. Existing account and vehicle settings
remain accessible. The seed dataset explicitly assigns private fleet memberships.

The composite shipment/driver/business foreign key is installed `NOT VALID` to
protect new assignments without destroying legacy history. Reconcile every legacy
driver and assignment, then execute:

```sql
ALTER TABLE shipments VALIDATE CONSTRAINT shipments_driver_business_fk;
```

Validation must pass before a release claims complete fleet integrity. Assignment
or membership changes that create a cross-business relationship are rejected by
PostgreSQL. A driver's membership cannot be transferred while incompatible
shipment references remain. Transfer/offboarding semantics require explicit design.

## Current limits

Invitation issue/accept/revoke/expiry, fleet suspension, bounded driver pagination,
HTTP regression tests, and full migration-runner upgrade tests remain outstanding.
The existing unauthenticated Socket.IO location channel is also a release blocker;
SQL fleet checks do not secure that separate channel. Apply this migration before
running the updated application; no live application database was migrated during
development.

# Backend closeout and frontend handoff

This is the fixed acceptance checklist for the current portfolio backend. It
supersedes open-ended "next build" planning. Optional feature requests belong in
a separate backlog; a new item enters this checklist only for a concrete defect
in the agreed workflows. Passing it means ready for frontend integration within
the stated scope, not unlimited capacity or unrestricted commercial launch.

## Scope

- Business/customer accounts and private invitation-only driver fleets.
- Versioned, idempotent shipment operations, recipient-code delivery, failed
  delivery and return custody, scoped HTTP/socket tracking and notifications.
- Stripe sandbox checkout, callback replay, reconciliation and full refund proof
  for received review balances. Normal applied-payment refunds, partial refunds,
  disputes and business payouts are outside this portfolio release. This is the
  recommended payment closeout scope; sandbox-only hosting was already agreed.
- Account deactivation was explicitly requested during closeout. It must preserve
  records, require current-password confirmation, invalidate sessions and guard
  unfinished work/fleet membership. It is not permanent erasure or self-reactivation.
- Main/live resources stay unchanged; frontend changes remain separate work.

## Acceptance gates

| ID   | Required result                                                                                          | Status / evidence                                                                                                                                          |
| ---- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-01 | Product scope and exclusions stated                                                                      | Defined above; deactivation approved, existing payment scope recommended.                                                                                  |
| C-02 | No unsafe self-service permanent account deletion; tested deactivation and dependency guards             | Verified locally: eight deactivation cases, including races, rollback, custody, finance and inactive-owner invitations.                                    |
| C-03 | Remaining API surfaces bounded, tenant scoped and validated                                              | Verified locally: five collection/settings/GPS cases; cursor pages, bounded mark-read batches and safe field projections.                                  |
| C-04 | Frontend-facing contract: routes, auth/cookies, roles, errors, versions, idempotency and pagination      | Defined in [frontend-handoff.md](frontend-handoff.md); first frontend authentication slice implemented separately.                                         |
| C-05 | Relevant regression and assembled role journeys pass against current candidate                           | Verified locally: 87 fast tests and 255 integration tests across three shards, zero skips/todos/failures in final reports.                                 |
| C-06 | CI result attributable to final candidate, migrations rehearsed and legacy FK release condition explicit | Fresh/upgrade migration tests pass. Final candidate CI/promotion remains required; historical fleet FK validation remains a release condition.             |
| C-07 | Hosted timeout investigation and bounded baseline outcome documented                                     | Independent diagnostic run 42522804865 attempt 3 succeeded. Initial hosted load remains failed; no capacity claim.                                         |
| C-08 | Release, rollback, recovery and operator ownership documented                                            | Runbooks retained; project owner controls CI/promotion, backup retention, alert destination and public cutover. Hosting obligations remain explicit below. |
| C-09 | Final readiness verdict and frontend handoff issued with remaining risks explicit                        | Ready for frontend implementation against the frozen contract. Hosted candidate acceptance remains unverified until C-06 promotion/smoke.                  |

## Evidence already available

The readiness register contains real PostgreSQL/Redis tests, assembled Bun journeys,
actual Stripe sandbox payment/replay/recovery/refund exercises, hosted logical
restore equality and local HTTP application checks against restored hosted data.
Reuse this evidence when its code/configuration is unchanged. Run tests again for
changed code, a changed environment, a failure or unresolved uncertainty.

Free-host availability, million-user capacity, frontend/browser adoption, public
traffic cutover and commercial financial operations are not established. A scoped
frontend handoff must distinguish these from unresolved correctness defects;
neither a numerical score nor a healthy endpoint can waive a failing required gate.

## Execution

1. Audit and settle scope (this document).
2. Apply required fixes and run meaningful regression/negative/race tests.
3. Review remote evidence, freeze the client contract, and issue one handoff.

The project owner controls GitHub/Render settings and release promotion. The coding
agent implements/reviews local changes and records evidence. No automatic main
merge, production migration or deployment is authorized by this checklist.

## Handoff boundary — 2026-11-09

Frontend integration has started on dev without promoting main. The backend
contract is available for client implementation; candidate deployment and browser
acceptance remain separate checks. Migrations 0016 and 0017 must reach preview
through the existing guarded workflow before testing the new deactivation and
collection behavior there. The Drizzle 0017 snapshot was generated locally and
its difference from 0015 was checked to contain only the three intended indexes.

The independent [diagnostic workflow](https://github.com/Ikenna-Lucky/IsoTrack--Backend/actions/runs/42522804865)
completed successfully on attempt 3, harness commit
2b9bfd79fe3a3b28d9ba17140840e42debc3858b. That does not verify the newer local
closeout changes or reverse the failed hosted sustained baseline.

Backend lint, types, build and 87 fast tests pass. Final shards 1, 2 and 3 pass
95, 51 and 109 cases respectively: 255 integration cases, zero failures,
cancellations, skips or todos. Evidence is in `reports/unit.{json,xml}` and
`reports/integration-{1,2,3}-of-3.{json,xml}`. These reports describe the local
working-tree candidate, not a newly committed/deployed release.

Shard 1's earlier attempt returned 93 passes and two failures (including a killed
Docker/psql command); retained as `integration-1-of-3-initial-failure.{json,xml}`.
The original unsharded attempt exceeded its 15-minute process deadline and remains
in `integration.{json,xml}`; it is not a passing report. Two orphaned disposable
containers were stopped before the complete sharded rerun. Both failed cases
passed in that rerun, without weakening their assertions or increasing deadlines.
This does not establish the definitive cause of the original hidden 500 response.

These finite gates finish the backend handoff; they are not a new feature backlog:
complete local regression, obtain candidate CI, promote only to preview and
confirm deployed identity/smoke. Free-host performance, independent backup
retention, alert delivery and public cutover remain explicit operating/release
limits rather than claims established by frontend work.

# Channel announcements verification

The feature contract is in [the implementation plan](../plans/2026-09-26-channel-announcements.md).
The current implementation has two independent standard-channel flags:
`adminOnlyPosting` and `mandatoryAnnouncements`. A confirmation-required post
must be a public, read-only, top-level human admin post.

## Database and service checks

Run the API tests through Turbo with `DATABASE_URL` pointing at an isolated,
fully migrated PostgreSQL database. `api/test/channel-announcements-db.test.ts`
creates its own organisation, team and channel. It checks direct-SQL and
service-level member posting refusal, private-channel confirmation refusal,
the frozen alert/receipt/push outbox,
exact seen and acknowledgement transitions, a later joiner who cannot confirm
an earlier post, one sender-authored reminder DM with an exact link, queue
replay, cancellation, sender departure, retry after a member rejoins, and
independent team and organisation mandatory audiences. The test
cleans up only its own tenant data.

`worker/test/push-dispatch.test.ts` covers a frozen recipient whose channel is
muted and whose ordinary message and mention push preferences are disabled.
`worker/test/push-preferences.test.ts` covers announcement preference bypass
and focus suppression. `packages/team-admin/test/channel-announcement-authority.test.ts`
covers exact-team admin, other-team admin, org admin, and system/DM refusal.

## Rendered controls

Run the headless suites from the worktree:

```sh
pnpm --filter @nessie/admin test:e2e:channel-decisions
pnpm --filter @nessie/admin test:e2e:channel-confirmations
```

The first suite uses the production Channel settings dialog and checks both
flag writes, a team admin who may configure only announcement settings, and
desktop/phone screenshots. The second mounts the production confirmation
control with a fake API: it checks the three status groups, manual reminder
request, foreground seen report, acknowledgement, and desktop/phone layouts.
The fake API deliberately isolates rendered behavior; it does not prove that
a signed-in browser can complete the same sequence through a running API or
that a UOA account receives push on a real device. Those remain separate
runtime and deployment checks.

`admin/test/alert-row-call-missed.test.ts` also checks that an announcement
alert labels the post correctly and opens the exact post even if an old alert
row has no root reference.

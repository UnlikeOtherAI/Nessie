# A capability that can stop working owns the way a person finds out

Authoritative standard, moved verbatim out of [`AGENTS.md`](../../AGENTS.md)
so it is read when the work touches this area rather than loaded into every
session. `AGENTS.md` carries the one-line invariant and points here; **this
file is the rule**.

- **A capability that can stop working owns the way a person finds out.** A
  recurring trigger whose captured UOA identity stopped verifying was flipped to
  `error` and abandoned — non-claimable by the sweep, abandoned by the retry
  poller, and announced to nobody, so one production schedule was dead and
  silent for nineteen days. The obligation sits on the **transition**, not on
  whoever might later look: classify the failure into a state that names its
  remedy (`needs_reauthorization` is a button; `error` is an edit), persist the
  reason so the surface can explain it, and alert exactly once per transition —
  `health_revision` plus the existing `user_alerts (user_id, event_key)`
  uniqueness, never a second marker table. Exactly-once is what separates this
  from the repeating-apology failure the unattended-run path deliberately avoids
  (`worker/src/run/execute/failure.ts`): an unattended run posts nothing to chat
  for good reason, so the signal has to be a durable alert instead. Recovery is
  **explicit** — `POST /api/triggers/:id/reauthorize` re-captures a live
  identity, sharing `captureScheduledLaunchOrigin` with the create route. Never
  auto-heal at login: signing in proves the same person is present, not that
  they intend a dormant automation to resume, and an epoch may have rotated
  because access was withdrawn. Re-stamp the **epoch only**; the organisation
  and team decide billing attribution, so refreshing them from whoever clicks
  repair moves a schedule's costs as a side effect. Re-arm from **now**, or a
  long-dead cron schedule grinds through every missed occurrence. And a fire
  gate must ask exactly what dispatch asks: checking a strict subset let
  triggers pass, create runs, and die at the first inference invisibly. Details:
  `CLAUDE.md` → "A schedule that stops says so".

## Detail

Moved verbatim out of [`CLAUDE.md`](../../CLAUDE.md) → "A schedule that stops says so".


The transition owns the alert — failure classification into a remedy-naming
state, exactly-once alerting per transition, explicit recovery (never
auto-heal at login), epoch-only re-stamp, re-arm from now: stated above.
Facts not
restated there:

- `TriggerLaunchOriginError` carries a reason code
  (`worker/src/control/trigger-origin.ts`): unprovable identity →
  `needs_reauthorization` (a button); everything else (target, membership,
  malformed origin) stays `error` (an edit). `health_reason` / `health_detail`
  persist the cause so the page can explain without parsing a message string.
- The transition is claimed by a single conditional UPDATE whose WHERE clause
  carries the decision — `dispatchEventTriggers` fans out with no claim on the
  trigger, so a read-then-write would have raced. `trigger.health-alert`
  writes a durable `UserAlert` for the organisation's active **owners** — the
  set who can both reach the owner-gated Triggers page and repair the schedule
  — and pushes under its own `pushTriggerHealth` preference with a generic
  body (the cause stays behind the deep link, so a lock-screen notification
  cannot carry a provider error). The alert is revalidated on read
  (`visibleUserAlertWhere`), so it stops surfacing once the trigger is healthy.
- `POST /api/triggers/:id/reauthorize` refuses and names a changed workspace;
  an owner taking over somebody else's schedule is a separate explicit act. It
  is the only recovery path: editing preserves the server-owned identity by
  design, resuming without repair re-arms into the same failure, and deletion
  is refused once any delivery exists.
- **Nothing about a trigger's provenance leaves the server.** The record
  presenter strips `launchOrigin` / `createdByUserId` / `createdViaTool`, the
  webhook intake key is opt-in per audience (`TRIGGER_ADMIN_AUDIENCE`) so a
  call site that does not consider audience omits it, and caller-supplied
  dedupe keys are namespaced by the route's own server-decided source — the
  scheduler's keys are predictable, and a caller could otherwise pre-create a
  delivery and silently cancel a future occurrence.

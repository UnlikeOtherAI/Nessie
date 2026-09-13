# User alerts — durable mention rows, the bell, and invitation reconciliation

Authoritative standard, moved verbatim out of [`AGENTS.md`](../../AGENTS.md) so
it is read when the work touches alerts rather than loaded into every session.
`AGENTS.md` → "Web Push & user alerts" carries the one-line summary and points
here; **this file is the rule.**

Direct @mentions write durable per-recipient `UserAlert` rows in the
message-create transaction (self skipped, broadcast none, agent-authored
identical; mute suppresses push, never the row) and surface via
`GET /api/alerts` + `POST /api/alerts/read`, realtime
`alert.created`/`alert.read`, the admin top-bar bell, and mention-framed push
(`<author> mentioned you in <channel>`). `team_invitation` alerts are
reconciled from every verified UOA `/org/me` read, follow the user's current
local organisation for bell visibility, and are deleted—not read-marked—when
UOA no longer returns the invite or acceptance succeeds.

A `team_invitation` row's `organizationId` is the **bell it appears in**, never
the invitation's own organisation. An invitation routinely arrives from an
organisation the recipient does not belong to yet, and `visibleUserAlertWhere`
requires an active membership of the row's organisation — so filing one under
the inviting organisation creates a row nobody can ever see. The invitation's
own organisation travels in the row's metadata (`organizationId`, and `orgName`
when UOA supplies it), which is what the switcher, bell and `/alerts` name on
the row so two organisations that both own a "General" can be told apart.
Acceptance posts that metadata organisation to
`POST /api/team/invitations/:inviteId/accept`, which never reads the session's
active organisation.

The verified read that reconciles these rows is no longer only login and token
rotation. `GET /api/auth/me` re-reads `/org/me` when the cached directory is
older than `DIRECTORY_FRESH_MS` (60 s, beside the 30-minute
`DIRECTORY_TTL_MS` in `api/src/services/uoa-directory-cache.ts`), bounded to one
in-flight read per user. A failed read still reconciles nothing: `undefined` is
not a verified empty directory, and the cached copy is served unchanged.

Push transports (APNs/FCM and browser Web Push) are described in
[docs/web-push.md](../web-push.md), including the two-layer contract every
notification goes through — a deterministic enqueue idempotency key, then a
`push_send_claims` row claimed per endpoint before any provider is called, so a
redelivered job never rings a device twice for a send that was accepted, while a
send that never reached the provider is still retried.

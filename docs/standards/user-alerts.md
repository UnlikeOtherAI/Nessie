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

Push transports (APNs/FCM and browser Web Push) are described in
[docs/web-push.md](../web-push.md), including the two-layer contract every
notification goes through — a deterministic enqueue idempotency key, then a
`push_send_claims` row claimed per endpoint before any provider is called, so a
redelivered job never rings a device twice for a send that was accepted, while a
send that never reached the provider is still retried.

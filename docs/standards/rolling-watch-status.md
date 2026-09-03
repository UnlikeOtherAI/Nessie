# A recurring watch keeps one rolling status message

Authoritative standard, moved verbatim out of
[`CLAUDE.md`](../../CLAUDE.md) so it is read when the work touches this area
rather than loaded into every session. `CLAUDE.md` carries the one-line
summary and points here; **this file is the rule**.


A sweep that finds nothing does not add a message. It edits the watch's own
status line in place — the model's latest words, plus a `checked 54× · last
09:12` counter rendered from `metadata.watchStatus` — so ninety-six quiet
sweeps a day stay one line instead of ninety-six messages burying the findings
the channel exists for.

Mechanics (`worker/src/run/execute/watch-status.ts` +
`watch-status-gate.ts`, folded in `completion.ts`):

- **The model always writes text.** Only the *routing* changes. Nothing here
  offers the model an "output is optional" affordance — that shape is what
  made every trigger run fail when `conclude_silently` shipped.
- **Two gates, structural first.** Only an unattended run belonging to an
  `interval`/`scheduled` trigger that has not set `config.rollingStatus:false`
  is eligible; then one small utility-model call judges the text as a finding
  or a no-change. That judgement **fails open** — any error, timeout or
  unparseable answer posts normally, because a missed finding is far worse
  than one redundant message.
- **The roll resets when anything else is said.** The fold only continues while
  the status line is still the newest visible message in the thread; a human
  post, another agent, or the watch's own finding starts a fresh line at 1.
  Purely structural (authorship + recency), never a reading of content.
- **Race-safe.** Find-newest → check-superseded → update-or-create runs inside
  one transaction under `pg_advisory_xact_lock(threadId, agentId)`, so two
  sweeps cannot both create a status row or both increment from the same count.
- **Quiet by construction.** An edit adds no row, so unread counts
  (`created_at > last_read_at`) do not move and `createMessageMentionAlerts`
  never runs. Realtime uses a `message.updated` event that refreshes only the
  open thread — deliberately not `['channels']`, so badges stay put.

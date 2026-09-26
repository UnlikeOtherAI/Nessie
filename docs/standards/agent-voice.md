# Agent voice, reactions and the working marker

Authoritative standard, moved verbatim out of
[`CLAUDE.md`](../../CLAUDE.md) so it is read when the work touches this area
rather than loaded into every session. `CLAUDE.md` carries the one-line
summary and points here; **this file is the rule**.


Agents answer at colleague length by default. The base system prompt
(`worker/src/run/execute/agent-behavior-prompt.ts`, assembled by
`buildModelPrompt` in `prompt.ts`) gives that a *shape*
rather than an adjective — lead with the answer, one short paragraph of plain
prose, no headers/tables/bullets unless the content genuinely is a list, go
long only when asked or when the content is irreducibly large, and on a
scheduled run report by exception. "Concise" alone had been in there for a
while and did not work: a routine hardware sweep still came back as ~400 words
with a table. This is prompt guidance and never an output cap — depth has to
stay one request away.

All agents refer to resources by name and clickable link, withholding internal
IDs/GUIDs unless asked. Existing lookup links are preferred; `nessie_link`
formats a named product link from identifiers a lookup already returned. It
does not discover resources, read new data or grant access. Its argument schema
is always available, and malformed arguments remain correctable. Knowledge
listings, search and page reads include canonical resource links directly. The shared prompt uses two
short instructions for this, replacing the longer message-link paragraph.
Machine-reach facts define executors as connected computers with command and
local-app tools, so an agent never has to infer that meaning from the name.

For action requests, the shared prompt explicitly explains that a text-only
reply ends the turn: a promise does not schedule execution. Agents must use
available tools, follow their results through to the requested outcome, or
explain a concrete blocker and the next action needed. Approval and deferred
work must actually be requested through their tools before being described as
pending. Before accepting a normal non-empty text-only answer, the main runner
asks its utility model for `{needsFollowUp, reason}` against the conversation
and tool results. A true decision continues the same run, preserving its tool
history and authorization, at most twice. The counter survives crash resume;
the check's inference counts toward the same budget. Approval/card suspensions,
wind-down, and provider-output recovery retain their existing stop behavior.
Malformed decisions fail visibly; repeated premature answers end with an
explicit failure instead of another promise. No phrase matching decides intent.
This resembles Codex's optional Stop-hook continuation, not a guarantee that
model judgement is infallible. Verify follow-through with a real model; an
assertion against prompt text alone cannot establish that work is finished.

Agents react rather than reply when a message needs registering but no answer.
Two paths, both producing real `MessageReaction` rows (an emoji typed into a
reply is still a message):

- **Before a run** — the engagement decision can return
  `{"action":"acknowledge", emoji}` instead of `{"action":"reply"}`, spending
  no run at all. Use for a thank-you, an FYI, a decision already made:
  anything where a prose reply would carry no information the person does not
  already have (`packages/runtime/src/orchestrator.ts`, applied in
  `worker/src/run/orchestrate.ts`).
- **During a run** — the `react` builtin adds or removes the agent's own
  reaction on any message its run can already see, the same buttons a person
  clicks (`worker/src/run/pa-tools/agent-messages.ts` `runReactTool`).
- **In a one-on-one room** — Jev makes that call before any run, for every
  message: a written reply, a reaction alone (👍, 🎉 or ❤️, no run), or the work
  done with tools and the message marked ✅ by the platform when the run ends
  with nothing worth reading. The run is told when no written reply is owed and
  to answer with a bare ✅, which the completion review still checks; the mark
  on the person's message is written in the run's own commit, never by the model
  ([reply-threads.md](reply-threads.md) → "One-on-one rooms").

A run also paints 👀 on the message it is working from
(`worker/src/run/execute/working-marker.ts`), so a person scrolling back can
see which message an agent picked up — the thinking bubble only shows in the
composer, and only while somebody is watching. The run owns that marker, not
the model: removal is fused to the terminal status transition in
`lifecycle.ts` `updateRunStatus`, so completion, failure, budget stop and
cancellation all clear it without having to remember, and a crashed run clears
it when the queue re-delivers it to a terminal state.

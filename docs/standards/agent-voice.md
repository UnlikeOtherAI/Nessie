# Agent voice, reactions and the working marker

Authoritative standard, moved verbatim out of
[`CLAUDE.md`](../../CLAUDE.md) so it is read when the work touches this area
rather than loaded into every session. `CLAUDE.md` carries the one-line
summary and points here; **this file is the rule**.


Agents answer at colleague length by default. The base system prompt
(`worker/src/run/execute/prompt.ts` `buildModelPrompt`) gives that a *shape*
rather than an adjective — lead with the answer, one short paragraph of plain
prose, no headers/tables/bullets unless the content genuinely is a list, go
long only when asked or when the content is irreducibly large, and on a
scheduled run report by exception. "Concise" alone had been in there for a
while and did not work: a routine hardware sweep still came back as ~400 words
with a table. This is prompt guidance and never an output cap — depth has to
stay one request away.

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

A run also paints 👀 on the message it is working from
(`worker/src/run/execute/working-marker.ts`), so a person scrolling back can
see which message an agent picked up — the thinking bubble only shows in the
composer, and only while somebody is watching. The run owns that marker, not
the model: removal is fused to the terminal status transition in
`lifecycle.ts` `updateRunStatus`, so completion, failure, budget stop and
cancellation all clear it without having to remember, and a crashed run clears
it when the queue re-delivers it to a terminal state.

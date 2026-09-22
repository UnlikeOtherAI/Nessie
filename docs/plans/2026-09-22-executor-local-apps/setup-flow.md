# PR 5 — Building the agent: the problems met on the way

Back to [overview](overview.md).

Each item was met live on 2026-09-22 while building a CTO agent through the
Agent Designer ([the usability report](../../testing/cto-agent-usability-2026-09-22.md)).
Each is small and independent; together they decide whether a person can go
from "make me a CTO" to "the CTO is working a ticket" without editing policy
JSON or pasting UUIDs.

## F11 — Project board tools must be granted explicitly, and the catalogue must say so

`resolveProjectDelegatedToolIds` (`worker/src/run/execute/run-setup.ts`) lends
`ticket_*` tools only when the agent's policy grants them `true`, but the
Designer's catalogue describes them as "on by default; set false to remove"
because `allowMode` is derived from `requiresExplicitGrant` alone
(`packages/team-admin/src/agent-tool-catalog.ts`). Fix: `allowMode` is
explicit for `requiresExplicitGrant || projectDelegatedOnly`, so the Designer
proposes the grant it promises. Test: the catalogue marks every
project-delegated tool explicit; a Designer-built agent with board ownership
gets `ticket_*` true.

## F13 — A project-channel agent knows its own project

`ticket_*` handlers default `projectId` to the run's channel project
(`context.channel.projectId`) for shared agents; the schema makes it optional
and says so. The "use project_list" hint that points a shared agent at a tool
it does not have is replaced. Not by teaching the agent to call
`channel_list` — that read stamps the write basis (F16).

## F16 — Recalled memory must not silently block every project write

When destination containment applies **and** the run holds project-delegated
write tools, memory recall is limited to lineage scopes `{organization,
project:<channel.projectId>}`; channel, user and private-conversation sources
are not admitted for that run. Every other run and the write gate are
unchanged. `channel_list`'s stamping of DMs it merely lists is fixed
separately: listing a channel's name is not reading its content. The
trade-off (such a run does not remember private-DM context) is written into
[disclosure-boundaries.md](../../standards/disclosure-boundaries.md).

## F22 — A new agent gets no channel of its own

The Designer's prompt and proposal card change from "the channel it will work
in" to "where it lives: the existing channels the person named, or nowhere
yet — people add it to any channel". `channel_create` stays available for when
a person asks for a channel, never as a default step. The card renders "Lives
in: nowhere yet — add it to any channel" when nothing was named. Pinned in the
proposal-card fixture suite and the Designer blueprint test.

## F6 — The Designer's executor-grant link must work

The confirmation token is a secret the model must never see (the secret
scanner rightly redacts it from tool output). The prepare tool instead posts a
structural **confirmation card** in the requester's DM — system-authored,
storing only the access-change id; pressing it opens the existing review with
the token resolved server-side for that same person. The model's tool result
says "I've put a confirmation card in your DM." No change to the access-change
rules themselves.

## F15 — Granted tools arrive with their schemas

Tools an agent's policy grants explicitly (`true`) and the run's
project-delegated tools join the deferred toolset's hot set, so the agent does
not spend a dozen `tool_spec` round trips before its first real action.

## F2 — A card press that committed is a success

In `agent-card-response.ts`, the audit, realtime publish and reply side effects
after the claim transaction commits are best-effort (logged, not thrown); the
route answers 200. The admin hook refreshes the card on settle, so a pressed
card never looks un-pressed.

## F8 — Portrait failures say why

The avatar prompt call gets a token budget a reasoning model can finish in
(2 000) and `reasoningEffort: 'low'`; an empty answer reports the finish
reason.

## F9 — The Designer does not leak ids or instructions meant for itself

`agent_create`'s output renders a channel link (`[#name](/channels/<id>)`) and
`portrait: none (reason: …)` instead of raw `agentId=`/`channelId=` UUIDs, and
the "quote the reason word for word" rule moves from the tool's data into the
Designer's prompt.

## Documents

[global-agents.md](../../standards/global-agents.md) (F11, F22),
[disclosure-boundaries.md](../../standards/disclosure-boundaries.md) (F16),
the Designer plan
[2026-09-20-agent-designer-capabilities-and-output-recovery.md](../2026-09-20-agent-designer-capabilities-and-output-recovery.md) (F6, F9).

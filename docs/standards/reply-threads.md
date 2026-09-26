# Message reply threads, reply placement, thinking bubbles, liveness

Authoritative standard, moved verbatim out of [`AGENTS.md`](../../AGENTS.md) so
it is read when the work touches reply threads or run reply routing rather
than loaded into every session. `AGENTS.md` → "Architecture" carries the
one-line summary and points here; **this file is the rule.**

## Reply threads (#233)

`Thread` is a conversation *container* (channel → named threads); Slack-style *reply threads* live one level deep on messages: `Message.rootMessageId` (nullable self-FK; replies to replies attach to the same root), with materialized per-root `replyCount`/`lastReplyAt`/`replyParticipantIds` updated atomically via `@nessie/runtime` `applyReplyBookkeeping` in the message-create transaction, and `MessageThreadFollow` per (user, root) with auto-follow on participate (author the root, reply, or be mentioned in a reply) plus explicit unfollow. Reply visibility inherits the container; deleted roots tombstone and keep their replies; "Also send to #channel" posts an inline top-level copy carrying `metadata.replyBroadcast.rootMessageId`. Message-create accepts `rootMessageId` (validated same-container top-level root); list defaults to top-level posts and takes `?rootMessageId=` for paginated replies; realtime adds `message.reply` + `message.reply.meta`. In a room with other people in it, a run triggered by a message replies **into that message's reply thread** by default (root = `triggerMessage.rootMessageId ?? triggerMessage.id`) — a room whose only person is the one talking answers in its main chat instead (see "One-on-one rooms" below) — and thread-following scopes to that reply thread; the legacy DeepWater launcher handoff and external-agent paths stay top-level and byte-identical. **A DeepWater research lives under its research card:** its results, notices and hidden wake kickoffs are posted at `card.rootMessageId ?? card.id` (`deepWaterReplyRoot`), so a woken agent's run answers in that reply thread, because placement follows its kickoff's root. The one exception is a notice about a person's brief that was never launched: the room was never shown it, so it goes top-level to the requester's own Personal Assistant conversation ([deepwater.md](deepwater.md) → "Delivery"). **Where a run replies and what it reads are separate questions** (`resolveReplyRootMessageId` vs `resolveConversationRootMessageId`): the conversation window narrows to a reply thread only when the trigger message is *itself* a reply. A run answering a top-level message is starting a reply thread, not sitting in one, so it reads the channel thread — scoping it to its own trigger would leave it a one-message window with no history. Admin: reply-summary bar under roots and a deep-linkable right-hand thread panel (`/channels/:id/threads/:threadId/replies/:rootId`); how it presents per layout, and how it closes, is the navigation framework's call ([docs/navigation/overview.md](../navigation/overview.md) §7, "The reply thread panel on `split`"). Reply-unread counters (#212) and the Threads inbox (#213) build on `MessageThreadFollow`.

Server-authored rows (`packages/team-admin/src/system-authored-message.ts`) are their
own door beside `createThreadMessage`, because none of a person's send
invariants — idempotency by `clientMessageId`, structured mention validation,
durable mention alerts, "also send to #channel" — apply to a product handoff
prompt, a mirrored external-agent turn, an executor notice, or a card press.
A server-authored reply may still be *addressed*: a DeepWater result or notice
alerts its requester explicitly, in the row's own transaction, with a durable
event key (`createMentionUserAlerts`, see
[user-alerts.md](user-alerts.md)), never by parsing mentions out of its text.
`followedByUserIds` is the caller's own claim about who participated: a live
product-handoff message auto-follows its requester, while mirrored
external-agent history deliberately follows nobody — auto-following two
hundred imported turns would bury the Threads inbox it exists to serve.
Posting *into* an existing reply thread rather than opening one goes through
`createSystemAuthoredReply`, which does the root's materialized
`replyCount`/`lastReplyAt`/`replyParticipantIds` bookkeeping in the same
transaction as the row and follows the *root* (not the reply) with the
caller's `followedByUserIds` — participate-to-follow is a property of the
conversation, and a server-authored notice usually adds nobody because the
people who owe it an answer already follow.

A read acknowledgement's cursor search is bounded, not exhaustive:
`findThreadForUser`/the read-state service (`api/src/services/message-read-state.ts`)
looks at only the newest `READ_CURSOR_CANDIDATE_LIMIT` (200) replies for a
readable one, because only the newest readable reply ever moves the cursor
and a reply panel with thousands of replies used to load every one of them on
every acknowledgement. If that newest page is entirely withheld by
disclosure, the cursor stays at the root — under-marking rather than
over-marking, the safe direction for a read receipt.

## Container threads as conversations

A `Thread` whose `agent_id` is set is a **conversation with that agent** — a
second, isolated context inside the same room, with its own model window, its
own run slot and its own title
([docs/plans/2026-09-08-agent-conversations.md](../plans/2026-09-08-agent-conversations.md)).
The room is still the audience: a conversation is readable by exactly the
people who can read its channel, so there is no ACL of its own, and the General
thread of a room keeps `agent_id NULL` and is not "with" anyone.
`startedByUserId` records who opened it, which is what the rename door reads.

**Titles.** A conversation opened empty carries the placeholder until somebody
speaks: the first top-level `user` message in a thread with `agent_id` whose
title is still the default becomes its title
(`titleConversationFromFirstMessage` in `api/src/services/message-create.ts`,
through the same `deriveConversationTitle` `startAgentConversation` uses, and
reported once on that send's 201 as `conversationTitle`), and after that only
the person who started it or someone who can manage its room may rename it —
the doorway is the conversation header's **Rename** action
(`admin/src/components/features/channels/rename-conversation.ts`).

**Previews.** A conversation's `lastMessagePreview` is the newest message *this
viewer* may read — `resolveDisclosureViewer` + `viewerSatisfiesBasis`, the same
predicate `listThreadMessages` withholds a feed row with — so a newest message
whose basis the viewer does not satisfy contributes null rather than an older
readable line, and grants are deliberately not consulted, which makes a preview
strictly more closed than the thread it quotes.

**The list rule**, stated once and implemented once in
`listAgentConversationsForUser` (`packages/team-admin/src/agent-conversations.ts`):
a thread is in agent X's list for viewer V when it passes
`buildViewerThreadWhere(V)` — the extracted predicate `findThreadForUser`
itself is now written on top of, so the read-state service, the list and the
start door cannot disagree — **and** either `thread.agentId = X`, or it is the
General thread of a channel holding an `agent_bindings` row for X whose
`principalUserId` is `NULL` or equals V. The second arm is what puts the rooms
an agent merely works in on its list (they are conversations too); the
`principalUserId` clause is what keeps one person's Personal Assistant presence
in a shared room out of another person's list. X itself is resolved as
`{ id: X, organizationId: { in: [tenant, null] } }` rather than through
`isAgentAccessibleToActor`, which refuses every system-managed agent and would
404 the assistant in its own DM; an agent the viewer cannot otherwise see
(`isAgentVisibleToUser` false) is a 404, so an id never confirms an agent
exists.

**The structural-address rule.** A top-level `user` message in a conversation
engages that thread's agent the way a message in its DM does — placement
`thread` in a shared room and the main chat in a one-on-one one, no
engagement judgement, no model call — decided in
`resolveConversationDecisions` (`worker/src/run/orchestrate.ts`) beside the
existing system-DM branch. That is what lets a conversation be started empty
and still be answered by its first message. It is keyed on structure only:
`thread.agentId` (a column), a top-level trigger (a message inside a reply
thread is a side discussion and keeps today's behaviour), the agent still being
bound to the room, and **`role === 'user'`** — the same anti-loop bound
`decideAgentEngagement` states, so an assistant-authored turn inside a
conversation engages nobody and two agents cannot talk each other in a circle
inside one. Other bound agents engage only when explicitly @mentioned, composed
in through the ordinary `resolveMentionedAgentDecisions` rather than a second
resolver.

**The `agentId: null` pin.** Every resolution of "the channel's thread" now
carries it, because a conversation created before a room's General row would
otherwise be mistaken for it:
`packages/team-admin/src/channel-records.ts` (`ensureDefaultThread` and the
channel-record read), `api/src/services/channels.ts` (the list's
`defaultThreadId`, which keeps meaning the General thread),
`worker/src/control/channels.ts` and
`worker/src/run/pa-tools/message-destination.ts`. `Channel.unreadCount` is the
opposite: it sums **every** thread of the channel the viewer can see, so the
sidebar still says "something new here" when the new thing is inside a
conversation. Recency was not widened with it — see the plan's "Later".

**The doors.** `GET`/`POST /api/agents/:agentId/conversations`,
`PATCH /api/threads/:threadId` (rename; refused for a General thread with
`THREAD_TITLE_FIXED`) and `GET /api/threads/:threadId/conversation`, all in
`api/src/routes/agent-conversations.ts` and all UUID-guarding the path id
before it reaches a `uuid` column. The assistant reaches the same functions
through `agent_conversation_start` / `agent_conversations_list`
([personal-assistant-tools.md](personal-assistant-tools.md)), and every agent
can point at one with `conversation_reference`; what those write is the
`metadata.conversationRef` doorway ([agent-cards.md](agent-cards.md)). The
browser proof is `admin/e2e/agent-conversations/`.

In Channels, an agent DM is the parent of its conversations in the left
navigation tree. The children reuse `AgentConversationList` and its access
scoped API query, with the compact channel-tree presentation. Selecting the
agent's bare DM opens its session home with a New conversation action and
example requests; selecting a child opens that exact thread. The existing
Conversations tool remains a doorway inside shared rooms, where agents do not
have a dedicated DM row in the sidebar. In an agent DM the Conversations rail,
phone header action and info action are hidden; Browser remains available when
the agent has that grant. An agent DM's General thread remains in the list, so
its older messages stay reachable.

## One-on-one rooms

Reply threads keep an exchange from interrupting the other people in a room. A
**single-person room** — a DM whose only member is the person talking
(`isSinglePersonRoom` in `worker/src/run/orchestrate-one-on-one.ts`:
`channel.type === 'dm'` and one `channel_members` row), which covers the
Personal Assistant's DM, a global agent's home, a private agent's home, a
shared agent's per-person DM and every conversation inside them — has nobody to
interrupt, so its answers go to the **main chat**. Standard channels, DMs
between people, group DMs and conversations in shared rooms keep the default
above. A turn written inside a reply thread still continues there in every
room: `resolveReplyRootMessageId`'s in-thread rule outranks any placement.

When the room also has exactly one agent (`isOneOnOneAgentRoom`; an
external-agent DM is excluded because every turn is proxied to its own
product), each message is structurally addressed to that agent, so **Jev**
decides *how* it answers, in one evaluation before the run — the bubble
anchors where the reply will land from its first thinking token
(`judgeOneOnOneTurn` in `packages/runtime/src/one-on-one-decisions.ts`, called
from `decideOneOnOneTurn`):

- **response** — `reply`, a written answer; `act`, do what was asked with the
  agent's tools, where the run is told no written reply is owed and to answer
  with a bare ✅ when done — not silence, which the loop reads as a failed
  provider and asks again — and the platform turns an answer with nothing worth
  reading into a ✅ on the person's message, in the run's own commit
  (`isMarkedDone`); or `acknowledge`, a reaction only — 👍, 🎉 or ❤️ — and no
  run.
- **earlier** — whether the message goes back to one of the recent top-level
  messages above the immediate exchange (the two newest are skipped, because
  that is where a reply already sits; at most twelve are offered), and which.
  Never asked for a message inside a reply thread.
- **offer_answer / offer_exact** — asked only when the message right above is
  the agent's own open card with prepared buttons that this person may answer:
  which button the words take, and whether they take it exactly as offered.
  Both at 0.95 or more resolve the card with this message as its answer, and
  the run executes that button's prepared call before the model is asked
  anything ([agent-cards.md](agent-cards.md) → "A prepared button runs its
  call").
- **reference** — how the answer points there: `mention`, in the main chat and
  in words; `link`, in the main chat with `metadata.messageRef` drawn as a chip
  that jumps to the earlier message (`MessageRefChip`, resolved from the
  reader's own feed, never a copy kept on the reply); or `thread`, posted in the
  earlier message's reply thread (the rule after the in-thread one in
  `resolveReplyRootMessageId`).

Every choice below 0.8 falls back — to a written reply, no earlier message,
`mention`, 👍. No judgement at all — no Ledger evaluation client, an evaluation
that failed or took longer than four seconds, a pinned snapshot that no longer
names the room's agent — leaves the room its structural answer: the system-DM
or conversation rule, or the engagement model for an ordinary agent DM, placed
in the main chat (`answerInMainChat`). Nothing is posted about a missing
judgement; a notice on every message of a private chat would be worse than the
plain answer it replaces.

The judgement is pinned once on the trigger's `Message.channelDecision`: a
`ChannelDecisionSnapshotSchema` with `policyFingerprint: 'one-on-one'`, no
authorizer, and the lineage of every turn Jev read exactly as the transcript
would admit them (`conversationTurnLineage`) — so a redelivered decide job reads
it back instead of judging again, and the run admits what its plan was derived
from (`admitTriggerMessageLineage`). The run reads its plan from that snapshot
(`readOneOnOnePlan`, `worker/src/run/execute/one-on-one-plan.ts`) and is told
what the message goes back to — quoted only from its own admitted transcript —
and whether no written reply is owed (`buildOneOnOnePlanBlock`, behind the
clock). The Personal Assistant's `agent_conversation_start` places the target's
answer by the same rule: the main chat when the destination is the requester's
own room.

## Reply placement + thinking bubbles

([docs/plans/2026-08-05-agent-thinking-bubbles-and-reply-routing.md](../plans/2026-08-05-agent-thinking-bubbles-and-reply-routing.md)): where a run's reply lands is decided **before** the run starts — engagement decisions carry a model-judged `replyPlacement` (`thread` = answer owed to the asker's exchange; `channel` = standalone message to the room; @mentions stamp `thread` and system DMs `channel` structurally, and a one-on-one room takes Jev's placement or the main chat — never content heuristics) persisted on `Run.replyPlacement`; `resolveReplyRootMessageId` (`worker/src/run/execute/reply-placement.ts`) applies it after the DeepWater-handoff/external-agent/PA-delegation carve-outs and persists the resolved anchor on `Run.replyRootMessageId`. While a run thinks, a per-run `ThinkingRecorder` coalesces visible reasoning deltas (2 KiB/250 ms) plus tool-activity lines into durable `run_thinking_chunks` rows, each also published on the thread SSE stream with its chunk id (`stream.reasoning` / `stream.thinking.tool`; `stream.start` now carries the reply anchor, and `stream.done` is always published last). A tool line can be rewritten in place — the same row, republished under the same chunk id — so a call that watches something for minutes (a coding-session wait) keeps one current line rather than one per look, and still names the ToolCall its call became (`ThinkingRecorder.replaceToolLine`); the admin replaces that entry where it stands (`appendThinkingEntry`). The admin renders a dashed, full-width **thinking bubble** with a 1–2-line live thought ticker wherever the reply will land — bottom of the channel feed for top-level replies; compact under the root row plus full bubble in the thread panel for threaded ones (reply text streams only where the reply will land) — and clicking it opens a centered thought-process dialog that streams live and merges the durable log (`GET /api/threads/:id/thinking` bootstrap for mid-run joiners, `GET /api/threads/:id/runs/:runId/thinking` full log, both thread-visibility-gated; `stream.*` stays excluded from SSE backlog replay). The dialog always reads the full log, and again each time another tool line is known to have returned, because only the full log carries a tool line's screenshots: the recorder names the `ToolCall` a line became once its call ends (`run_thinking_chunks.tool_call_id`), and a line whose call returned a local program's images carries their refs, drawn as thumbnails under it ([executor-local-mcp.md](executor-local-mcp.md) → "People see a call's screenshots where they read the call").

## Liveness (client only, no server events)

The thread SSE reconnect policy lives in `admin/src/facades/threads/stream-retry.ts`: only **403/404** end the loop (the viewer cannot see this thread); every other outcome — 401 mid token rotation, any 5xx, a bodyless 200, a network error — reconnects with equal-jitter exponential backoff (1 s base, 30 s cap) that resets on each established connection. It used to `break` on any non-OK response, which killed bubbles and streaming text for the rest of the component's mount while replies kept arriving over the WebSocket refetch path. Because `stream.start` only fires after queue pickup, the engagement-decision call, a second queue hop, run claim, toolset assembly and memory retrieval, the admin also shows one **anonymous ambient line** — three muted `.liveness-dots`, no name, no avatar (`liveness-hint.ts` + `useAgentLivenessHint.ts`, `ChannelMessageFeed` `showLivenessHint`) — from the moment the viewer posts into a surface that structurally has an agent (bound agent, PA DM, or external-agent DM). It never names an actor because the engagement decision is model-judged and may decline, and it clears on the first of: a pending stream entry for that surface (the bubble *is* the indicator, so the two are never painted together — visibility is derived during render, not cleared in an effect), a message from anyone but the viewer, an agent reaction (`acknowledge`), or 10 s. Idle renders nothing; the channel feed and the reply panel share the one hook and the one feed component.

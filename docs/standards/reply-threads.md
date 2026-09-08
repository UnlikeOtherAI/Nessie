# Message reply threads, reply placement, thinking bubbles, liveness

Authoritative standard, moved verbatim out of [`AGENTS.md`](../../AGENTS.md) so
it is read when the work touches reply threads or run reply routing rather
than loaded into every session. `AGENTS.md` → "Architecture" carries the
one-line summary and points here; **this file is the rule.**

## Reply threads (#233)

`Thread` is a conversation *container* (channel → named threads); Slack-style *reply threads* live one level deep on messages: `Message.rootMessageId` (nullable self-FK; replies to replies attach to the same root), with materialized per-root `replyCount`/`lastReplyAt`/`replyParticipantIds` updated atomically via `@nessie/runtime` `applyReplyBookkeeping` in the message-create transaction, and `MessageThreadFollow` per (user, root) with auto-follow on participate (author the root, reply, or be mentioned in a reply) plus explicit unfollow. Reply visibility inherits the container; deleted roots tombstone and keep their replies; "Also send to #channel" posts an inline top-level copy carrying `metadata.replyBroadcast.rootMessageId`. Message-create accepts `rootMessageId` (validated same-container top-level root); list defaults to top-level posts and takes `?rootMessageId=` for paginated replies; realtime adds `message.reply` + `message.reply.meta`. A run triggered by a message replies **into that message's reply thread** by default (root = `triggerMessage.rootMessageId ?? triggerMessage.id`), and thread-following scopes to that reply thread; DeepWater/product-handoff and external-agent paths stay top-level and byte-identical. **Where a run replies and what it reads are separate questions** (`resolveReplyRootMessageId` vs `resolveConversationRootMessageId`): the conversation window narrows to a reply thread only when the trigger message is *itself* a reply. A run answering a top-level message is starting a reply thread, not sitting in one, so it reads the channel thread — scoping it to its own trigger would leave it a one-message window with no history. Admin: reply-summary bar under roots and a deep-linkable right-hand thread panel (`/channels/:id/threads/:threadId/replies/:rootId`); how it presents per layout, and how it closes, is the navigation framework's call ([docs/navigation/overview.md](../navigation/overview.md) §7, "The reply thread panel on `split`"). Reply-unread counters (#212) and the Threads inbox (#213) build on `MessageThreadFollow`.

Server-authored rows (`api/src/services/system-authored-message.ts`) are their
own door beside `createThreadMessage`, because none of a person's send
invariants — idempotency by `clientMessageId`, structured mention validation,
durable mention alerts, "also send to #channel" — apply to a product handoff
prompt, a mirrored external-agent turn, an executor notice, or a card press.
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
`thread`, no engagement judgement, no model call — decided in
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

## Reply placement + thinking bubbles

([docs/plans/2026-08-05-agent-thinking-bubbles-and-reply-routing.md](../plans/2026-08-05-agent-thinking-bubbles-and-reply-routing.md)): where a run's reply lands is decided **before** the run starts — engagement decisions carry a model-judged `replyPlacement` (`thread` = answer owed to the asker's exchange; `channel` = standalone message to the room; @mentions and PA DMs stamp `thread` structurally, never by content heuristics) persisted on `Run.replyPlacement`; `resolveReplyRootMessageId` (`worker/src/run/execute/reply-placement.ts`) applies it after the DeepWater-handoff/external-agent/PA-delegation carve-outs and persists the resolved anchor on `Run.replyRootMessageId`. While a run thinks, a per-run `ThinkingRecorder` coalesces visible reasoning deltas (2 KiB/250 ms) plus tool-activity lines into durable `run_thinking_chunks` rows, each also published on the thread SSE stream with its chunk id (`stream.reasoning` / `stream.thinking.tool`; `stream.start` now carries the reply anchor, and `stream.done` is always published last). The admin renders a dashed, full-width **thinking bubble** with a 1–2-line live thought ticker wherever the reply will land — bottom of the channel feed for top-level replies; compact under the root row plus full bubble in the thread panel for threaded ones (reply text streams only where the reply will land) — and clicking it opens a centered thought-process dialog that streams live and merges the durable log for mid-run joiners (`GET /api/threads/:id/thinking` bootstrap, `GET /api/threads/:id/runs/:runId/thinking` full log, both thread-visibility-gated; `stream.*` stays excluded from SSE backlog replay).

## Liveness (client only, no server events)

The thread SSE reconnect policy lives in `admin/src/facades/threads/stream-retry.ts`: only **403/404** end the loop (the viewer cannot see this thread); every other outcome — 401 mid token rotation, any 5xx, a bodyless 200, a network error — reconnects with equal-jitter exponential backoff (1 s base, 30 s cap) that resets on each established connection. It used to `break` on any non-OK response, which killed bubbles and streaming text for the rest of the component's mount while replies kept arriving over the WebSocket refetch path. Because `stream.start` only fires after queue pickup, the engagement-decision call, a second queue hop, run claim, toolset assembly and memory retrieval, the admin also shows one **anonymous ambient line** — three muted `.liveness-dots`, no name, no avatar (`liveness-hint.ts` + `useAgentLivenessHint.ts`, `ChannelMessageFeed` `showLivenessHint`) — from the moment the viewer posts into a surface that structurally has an agent (bound agent, PA DM, or external-agent DM). It never names an actor because the engagement decision is model-judged and may decline, and it clears on the first of: a pending stream entry for that surface (the bubble *is* the indicator, so the two are never painted together — visibility is derived during render, not cleared in an effect), a message from anyone but the viewer, an agent reaction (`acknowledge`), or 10 s. Idle renders nothing; the channel feed and the reply panel share the one hook and the one feed component.

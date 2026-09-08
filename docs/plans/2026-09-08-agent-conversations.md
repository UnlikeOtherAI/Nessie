# Agent conversations — many isolated conversations with one agent

Status: design, 2026-09-08. Implementation lands on
`claude/agent-multi-conversation-verify-807d6d`.

## The problem

Several people and several pieces of work talk to the same agent, and today
all of it lands in one context: a channel has exactly one `Thread`
("General"), every run of that agent in that room is serialised behind the
one `(agent, thread)` slot, and the model's window is the whole room. Two
unrelated asks interleave, a long job blocks a short question, and nothing
tells a person which of the agent's threads of work exist or where they are.

What is wanted:

1. A person, or the Personal Assistant on their behalf, can **start a new
   conversation with an agent** — a fresh context — and send it a job.
2. **Every agent has a list of its conversations**, visible from the
   conversation you are standing in (the tool rail beside the chat) and from
   the agent's own page.
3. The list shows **only what the viewer is privy to**: a conversation in a
   private room, a project channel they are not in, or another person's DM
   with the assistant never appears.
4. The agent that sent the job — the Personal Assistant, usually — can
   **refer to a conversation as a small live card** in its own chat: what it
   is, whether it is running, what it is doing right now, and a way in, so a
   person can watch progress or step in without being told to go and look.
5. A **verification system** proves all of it: many conversations, isolated
   contexts, concurrent runs, scoped visibility, live cards — in the
   database, in the worker, and in the real browser.

## The decision: a conversation is a `Thread`

`Thread` is already the boundary for everything that matters, and it is the
only one:

| Concern | Keyed on |
|---|---|
| Run serialisation (`claimThreadRunOrPend`, `packages/db/src/thread-serialization.ts`) | `(agent, principal, thread)` |
| The model's window (`loadConversation`, `worker/src/run/execute/prompt.ts`) | `threadId` |
| Live stream, thinking bubbles, read state, unread counts, Threads inbox | `threadId` |
| Reply threads, presented dashboards, browser sessions, todos, cards | `threadId` |

`docs/standards/reply-threads.md` already describes `Thread` as "a
conversation container (channel → named threads)"; the schema allows many per
channel; only the client assumes one (`channel.defaultThreadId`). So the
change is not a new model — it is making the second thread real, and giving
threads an owner agent so an agent's list is a query rather than a heuristic.

Rejected alternatives, so nobody re-litigates them:

- **A new channel per conversation** (what `POST /api/channels/conversations`
  does). Every conversation would be a room with its own membership, its own
  sidebar entry and its own binding — placement, which is owner-gated, for
  what is really "another topic with the same agent in the same room".
- **A `Conversation` table beside `Thread`.** A second container keyed on the
  same things is the forked surface Rule zero forbids; every subsystem in the
  table above would need a second key.
- **Reply threads as conversations.** A reply thread hangs off a message and
  narrows the window to that root only when the trigger is itself a reply;
  it is a side discussion, not a fresh context, and cannot be started empty.

### What a conversation is

- **The room is the audience.** A conversation lives in a channel and is
  readable by exactly the people who can read that channel — public in the
  organisation, or a member — the predicate `findThreadForUser` already
  applies (`api/src/services/message-read-state.ts`). No new ACL. "Privy
  to" is that predicate; for the Personal Assistant it is that predicate over
  its per-person DM.
- **A conversation is with one agent.** `threads.agent_id` names it. Other
  agents bound to the room can still be @mentioned inside it, as anywhere.
  The room's General thread has `agent_id NULL` and is not "with" anyone.
- **A conversation is a structural address.** A top-level user message in a
  thread whose `agent_id` is set engages that agent the way a message in
  its DM does — placement `thread`, no model engagement decision — so a
  conversation can be started empty and the first message still reaches the
  agent. Other bound agents engage only when @mentioned. This is decided in
  the orchestrator beside the existing PA-DM structural branch, never by
  reading content.
- **One in-flight run per conversation, many per agent.** Unchanged
  invariant, now useful: two conversations with the same agent run at the
  same time; a second message in the same conversation pends and batches.
- **Titles are text, not intent.** `threads.title` is the caller's title or
  the first line of the opening message (whitespace-collapsed, ≤ 80 chars);
  no model call. Renamable by whoever started it or can manage the channel.

## Data

One additive migration (new file under `api/prisma/migrations/`; existing
ones are immutable):

```sql
ALTER TABLE threads
  ADD COLUMN agent_id uuid NULL REFERENCES agents(id) ON DELETE SET NULL,
  ADD COLUMN started_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX threads_agent_updated_idx ON threads (agent_id, updated_at DESC) WHERE agent_id IS NOT NULL;
CREATE INDEX threads_channel_agent_idx ON threads (channel_id, agent_id);
```

No backfill: every existing thread is a General thread. `Thread.metadata`
stays what it is (external-conversation round-tripping) and is not used for
any of this. Every "the channel's thread" resolution — `listChannelsForUser`'s
`threads: { take: 1 }`, the three `ensureDefaultThread` copies
(`worker/src/control/channels.ts`, `worker/src/run/pa-tools/message-destination.ts`,
`api/src/services/channels.ts`) — adds `agentId: null` to its `where`, so a
conversation created before a channel's General row could never be mistaken
for it. `defaultThreadId` on `ChannelRecord` keeps meaning the General thread.

`Channel.unreadCount` sums every thread of the channel the viewer can see,
not only General (`loadUnreadCountsByThread` takes all of the channel's
thread ids). The sidebar therefore still says "something new here" when the
new thing is inside a conversation.

## Shared contract (`@nessie/schemas`, `@nessie/team-admin`)

Built first, alone, before any parallel work: the API, the worker and the
admin all import it.

```ts
// packages/schemas/src/agent-conversations.ts
export const AgentConversationRecordSchema = z.object({
  id: ThreadIdSchema,
  agentId: AgentIdSchema,
  title: z.string(),                       // never empty: General rows carry the room name
  isGeneral: z.boolean(),                  // the room's own thread (agent_id NULL) — see list rule
  channel: z.object({
    id: ChannelIdSchema,
    label: NonEmptyStringSchema,
    type: z.enum(['standard', 'dm']),
    systemChannelType: SystemChannelTypeSchema.nullable(),
    projectName: z.string().nullable(),    // null for standalone / DM
  }),
  startedByUserId: UserIdSchema.nullable(),
  lastActivityAt: TimestampSchema.nullable(),
  // ≤ 120 chars of the newest message the viewer may read. Fails closed: a
  // message carrying any basis scope contributes null, never a redaction.
  lastMessagePreview: z.string().nullable(),
  unreadCount: z.number().int().nonnegative(),
  activeRun: z.object({
    id: RunIdSchema,
    status: RunStatusSchema,               // pending | running | waiting_approval | waiting_input
    startedAt: TimestampSchema.nullable(),
    // The newest readable thought-log line of the running run (≤ 160 chars) —
    // what the card and the list show as "doing now". Null when the run has
    // written nothing yet, is not yet running, or when the viewer would be
    // withheld its reply (`canUserReadRunBasis` false), exactly as
    // `loadThreadThinking` withholds the bubble's entries.
    progressLine: z.string().nullable(),
  }).nullable(),
  // The last terminal run's outcome, so a card can say "Done" or "Failed"
  // after the live dot goes: null until a run has finished in this thread.
  lastRunOutcome: z.enum(['completed', 'failed', 'cancelled']).nullable(),
  createdAt: TimestampSchema,
})
// One conversation, by thread — the read behind a card and a deep link.
export const loadConversationForUser = (prisma, { threadId, userId, organizationId })
  => Promise<AgentConversationRecord | null>   // null = not visible; a General thread of a channel with no bound agent is null too
export const StartAgentConversationBodySchema = z.object({
  channelId: ChannelIdSchema.optional(),
  title: z.string().trim().min(1).max(80).optional(),
  message: z.string().trim().min(1).optional(),
  clientMessageId: z.string().optional(),
}).strict()
export const RenameThreadBodySchema = z.object({ title: z.string().trim().min(1).max(80) }).strict()
```

Pagination is the repo's own: `PaginationParamsSchema` in, `{ data, meta }`
with `PaginationMetaSchema` out, keyset on `(lastActivityAt DESC, id)`,
`limit` ≤ 100.

```ts
// packages/team-admin/src/agent-conversations.ts
export const buildViewerThreadWhere = (userId, organizationId): Prisma.ThreadWhereInput
// — the exact predicate findThreadForUser uses today, extracted so the read-state
//   service, the list and the start door cannot disagree. findThreadForUser
//   is rewritten on top of it.

export const listAgentConversationsForUser = (prisma, {
  agentId, userId, organizationId, limit, cursor,
}) => Promise<{ data: AgentConversationRecord[]; meta: PaginationMeta }>
```

List rule, stated once here and implemented once there — a thread is in
agent X's list for viewer V when it passes `buildViewerThreadWhere(V)` and:

- `thread.agentId = X`, **or**
- it is the General thread of a channel holding an `agent_bindings` row for X
  whose `principalUserId` is `NULL` or equals V.

The second arm is what makes the rooms an agent works in appear as
conversations too (they are), and the `principalUserId` clause is what keeps
the Personal Assistant's shared-room presence for one person out of another
person's list. The agent itself is resolved as
`{ id: X, organizationId: { in: [tenant, null] } }` — deliberately **not**
`isAgentAccessibleToActor`, which refuses every system-managed agent and so
would 404 the Personal Assistant in its own DM (see the browser-cloud routes
for the same reasoning). Zero rows for an agent the viewer cannot otherwise
see (`isAgentVisibleToUser` false) is a 404, so an id never confirms an
agent exists.

```ts
export const startAgentConversation = (prisma, {
  agentId, organizationId, startedByUserId, channelId?, title?,
}) => Promise<
  | { kind: 'created'; thread: { id; channelId; title } }
  | { kind: 'agent_not_found' }
  | { kind: 'no_room' }            // no channel the caller may post in has this agent
  | { kind: 'channel_not_allowed' } // given channel: not visible, not postable, or agent not bound
>
```

Room resolution when `channelId` is omitted, in order: the caller's own DM
with the agent (`dmKey` `pa:{org}:{user}` for the assistant,
`gagent:{slug}:{org}:{user}` for a global agent,
`agent:{org}:{user}:{agent}` for a private agent, or the two-party `dm`
channel whose bindings are exactly this agent), else the most recently
active channel the caller may post in that binds the agent. `no_room` is an
answer, not a fallback: the door never creates a channel or a binding. A
system channel is admitted only for its own agent (the PA DM for the PA, a
`gagent:` DM for that global agent) — `assertGlobalAgentRunPlacement` keeps
holding because the room is unchanged. The function writes the `Thread`
only; it authors no message and claims no run, because those go through
two different doors depending on who is speaking (below).

## API

- `GET /api/agents/:agentId/conversations?limit&cursor` → paginated
  `AgentConversationRecord[]`, via `listAgentConversationsForUser`. UUID-guard
  the id first (a malformed id reaching a uuid column is a 500).
- `POST /api/agents/:agentId/conversations` → 201
  `{ conversation: AgentConversationRecord, message: MessageRecord | null }`.
  Calls `startAgentConversation`, then, when `message` is present, posts it
  through `createThreadMessage` (`api/src/services/message-create.ts`) — the
  person's own door, so idempotency by `clientMessageId`, mention validation,
  alerts and participate-to-follow all hold — and dispatches exactly as
  `POST /api/threads/:threadId/messages` does. If that dispatch lives in the
  route handler today, lift it into the service in this change; the new door
  must not carry a second copy. Errors: 404 `AGENT_NOT_FOUND`, 409
  `AGENT_CONVERSATION_NO_ROOM` ("Add {agent} to a channel first" — an owner
  sees the bind door named), 403 `AGENT_CONVERSATION_CHANNEL_NOT_ALLOWED`.
- `PATCH /api/threads/:threadId` `{ title }` → the record. Allowed for the
  thread's `startedByUserId` or anyone `canManageChannel` on its channel;
  refused (400 `THREAD_TITLE_FIXED`) for a General thread.
- `GET /api/channels` — `defaultThreadId` pinned to `agentId: null`;
  `unreadCount` across all visible threads.
- `GET /api/threads/activity` (the Threads inbox) — rows carry the thread's
  `title` and `agentId` so the inbox can name a conversation and link to it.
- `GET /api/threads/:threadId/conversation` → one `AgentConversationRecord`
  via `loadConversationForUser`; 404 `THREAD_NOT_FOUND` when not visible, in
  the same words as the other thread reads so an id confirms nothing. This
  is the read behind the conversation card, so it is cheap: one thread, its
  channel, the newest readable message, the active run and its newest
  readable thinking chunk.

No new realtime kind. The list refetches on the rail's cadence while its
column is open and is invalidated on every send from the client; a new
`NOTIFY` kind would have to be inert to the previous build during a
blue-green swap and buys nothing here.

## Worker

- **Orchestrator.** `worker/src/run/orchestrate.ts` (the `decide` path):
  when the trigger message's thread has `agentId` set and the message is
  top-level (no `rootMessageId`), the candidate set is that agent alone
  plus any explicitly @mentioned bound agents, placement `thread`, no model
  engagement call — the same branch shape as the PA-DM structural case. A
  reply inside a reply thread keeps today's behaviour. The run's
  `replyPlacement` is stamped `thread` structurally.
- **PA tool `agent_conversation_start`** (`worker/src/run/pa-tools/agent-conversations.ts`,
  registered in `@nessie/runtime` `builtin-agent-tools.ts` beside
  `agent_handoff`; member-level; visible to non-owners and refuses in words).
  Input `{ agent: string (name or id), message: string, title?: string,
  channel?: string (name or id) }`. Resolves the agent through
  `listAgentsForUser` — the same entitlement `agent_list` and `GET /api/agents`
  use, plus the actor's own home DMs for system agents — so an agent the
  person merely named is addressable and an invisible one is "not found",
  never "forbidden". Calls `startAgentConversation` with the run's acting
  member (`resolveActingMember` / `requireActingUserId`, `pa-tools/access.ts`).
  Then, because the speaker is the assistant and not the person, writes the
  opener through the **agent** door — `createAgentMessage`
  (`worker/src/run/execute/agent-message.ts`) with `agentId` = the assistant,
  `onBehalfOfUserId` = the actor, and a disclosure basis computed exactly as
  `agent_handoff` computes its brief (`requireConsumedSources` →
  `computeReplyBasis` against the destination, minus what the requester
  already satisfies) — and claims the target's run with `claimThreadRunOrPend`
  for `(targetAgent, thread)`, `triggerMessageId` = the opener,
  `replyPlacement: 'thread'`, `interactive: false`, the PA run's
  `actorContext` (so the target's tools are gated as that person's ask).
  Allowed on unattended runs: a scheduled "every morning ask the researcher
  to…" is the point. In the **same transaction** as the opener it writes the
  doorway back into the origin thread (below), so the card exists the moment
  the job does. Output names the conversation, where it is
  (`formatChannelScope`), the thread id, and says in one sentence that a live
  card for it now sits in this thread, so the model refers people to the
  card rather than narrating status it cannot see.
- **PA tool `agent_conversations_list`** `{ agent: string }` — the read that
  resolves the ids the other two tools take (the `agent_list` →
  `agent_bind_channel` rule): the same `listAgentConversationsForUser` as
  the route, as the acting member, first page, each row as one line
  (`title · where · status · thread id`).
- **Tool `conversation_reference`** `{ conversation: string (thread id),
  note?: string }` — for **every** agent that can talk, default-on exactly
  like `card_post` (`safe: false`, no `personalAssistantOnly`, no explicit
  grant): showing a conversation is a better-shaped message, not a wider
  permission, and what the viewer then sees is decided per viewer by the
  card's own read. It validates the thread through `buildViewerThreadWhere`
  for the acting person — an autonomous run with no person is bounded to its
  own channel, as `assertReachableImages` bounds a card image — and posts one
  agent-authored message (`createAgentMessage`, the run's basis applied)
  whose content is `note` or a one-line default and whose metadata carries
  the doorway. Its description tells the model what the card shows, so it
  does not restate it.
- `spawn_subtask`, triggers, mailboxes, external agents: untouched. Their
  threads are General threads; they appear in the list through the binding
  arm.

### The doorway: `metadata.conversationRef`

```ts
// packages/schemas/src/conversation-ref.ts
export const CONVERSATION_REF_SCHEMA_VERSION = 1
export const ConversationRefMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  threadId: ThreadIdSchema,
  channelId: ChannelIdSchema,
  agentId: AgentIdSchema,
}).strict()
```

On `Message.metadata.conversationRef`, **server-written only** — by the two
tools above, from rows they just read or wrote, never from model text (the
`documentRef` / `agentHandoffDoorway` discipline). It is the
`agentHandoffDoorway` pattern generalised: a pointer on an ordinary message,
rendered as a doorway. It is deliberately *not* an `AgentCard`: nothing is
pressed and nothing resolves, so `docs/standards/agent-cards.md`'s own
boundary (the search card) says it rides in message metadata; and unlike the
search card it is **live** — the card carries no state of its own and renders
whatever `GET /api/threads/:threadId/conversation` says right now. A card
whose metadata carried a status would be a snapshot that lies within a
minute. `AgentHandoffDoorway` stays as it is (it points at a DM, not a
conversation); a later change may fold it onto this schema.

## Admin

Everything below is one framework and one set of primitives:
`docs/navigation/overview.md` for every screen/route/Back, `TabBar`,
`IdentityTile`, `UnreadBadge`, `Skeleton`, `Notice` from
`components/primitives/`, tokens only (`var(--x)`), no nested frames.

### The channel page becomes thread-aware

Route `:channelId/threads/:threadId` is added as an index sibling of the
existing `…/threads/:threadId/replies/:rootMessageId` and
`…/threads/:threadId/dashboards/:dashboardId` (`admin/src/router.tsx` ≈ line
288). In `ChannelsPage` one value, `activeThreadId = threadId ??
activeChannel.defaultThreadId`, replaces every `activeChannel?.defaultThreadId`
read — feed, composer (`useSendMessage`), stream, read marking, thinking,
reply thread (`useReplyThread` already does this), dashboards, browser
sessions, `useAdminShell`'s current thread, `useMessageNotifications`'
active-thread resolution, `prewarm.ts`. Nothing may keep reading
`defaultThreadId` for "the thread on screen"; grep it before finishing.

On a conversation (`activeThreadId !== defaultThreadId`) the header shows
the **thread title** as the title, the room as the eyebrow ("#design ·
Website" / the agent's name for a DM), and Back returns to the room's
General. On `single` the conversation is a pushed `detail` under the
channel; on `split` it replaces the conversation column — the framework's
call, not this page's. The composer placeholder reads
"Message {agent}" in a conversation, since that is who it reaches.

### The tool rail lists the agent's conversations

`components/features/channels/tool-rail/chat-tools.ts`:
`CHAT_TOOL_IDS = ['conversations', 'browser'] as const` — the list first,
the browser second, because one is *the agent's work* and the other is a
tool it uses. `ChatTool` gains `available: (agent: AgentRecord) => boolean`:
`conversations` is always available, `browser` when `browserEnabled`. The
rail is drawn whenever the conversation has one agent
(`conversationAgent !== null`, the PA's DM included) and draws each tool
whose `available` holds; `chatToolDoorway`'s `hasConversationAgent` stops
meaning "has a browser". The header doorway on `single` lists the same
available tools. The `conversations` mark is a two-speech-bubble SVG in the
rail's idiom (24 viewBox, stroke 1.6, `currentColor`), label
"Conversations", description "Every conversation with this agent you can
see — switch between them or start another." Its live dot means: a listed
conversation *other than the one on screen* has an active run.

### The column: `AgentConversationsPanel`

`components/features/agents/conversations/AgentConversationsPanel.tsx`,
opened by `ChatToolDock` in the `SidePanelShell` frame exactly as
`AgentScreenPanel` is, `aria-label="Conversations with {agent}"`.
Top to bottom:

1. **Header row** — `IdentityTile` of the agent (the sidebar's size), the
   word "Conversations", the shell's close control. No second frame.
2. **"New conversation"** — one full-width primary button directly under the
   header. Pressing it POSTs `{ channelId: <current room> }` (no message: the
   conversation is created empty, in the room the person is standing in),
   then navigates to `/channels/:channelId/threads/:newThreadId` and focuses
   the composer. Pending state disables the button with the shell's pending
   idiom; failure renders a `Notice` inline under the button with the API's
   message (a 409 `no_room` cannot happen from a room the agent is in, but
   the copy is rendered, not swallowed).
3. **The list** — `AgentConversationList` (the component the agent page's
   tab reuses; scope-parameterised, never copied). `role="list"`, each row
   a `button` in a `listitem`, ordered as the API returns. Row anatomy, left
   to right:
   - leading 8 px slot: a `--success` dot when `activeRun` is set, else an
     `UnreadBadge` when `unreadCount > 0`, else empty (the slot stays so
     titles align);
   - title, one line, ellipsis; General rows show the room ("#design",
     "Direct message", "Personal Assistant");
   - second line, muted, one line: `lastMessagePreview` when present, else
     "No messages yet";
   - trailing, muted, top-aligned: relative time of `lastActivityAt`
     ("now", "4m", "2h", "Tue", "3 Sep"), and under it a small room chip
     (`Pill`) with the channel label when the row's channel is not the one
     on screen — so a cross-room row says where it goes.
   - the conversation on screen is `aria-current="true"` and takes the
     shell's selected background; hover/focus take the shell's rail states.
   Selecting a row navigates to that thread's URL; the column stays open
   (rail state is per agent).
4. **"Show older"** — a quiet button at the end while `meta.hasMore`.
   Loading: three `Skeleton` rows. Empty: a centred muted line "No
   conversations yet" under the button (the button is the empty state's
   action). Error: `Notice` with retry.

Queries: `agentKeys.conversations(agentId)` in `facades/agents/keys.ts`
(family root, no literal keys), hook `useAgentConversations(agentId, {
enabled, refetchInterval })` in `facades/agents/hooks.ts` polling at
`RAIL_POLL_MS` while the rail is visible and `WATCHING_POLL_MS` while the
column is open, `placeholderData: keepPreviousData` because the key carries
an id; the mutation `useStartAgentConversation` invalidates the family and
the channel list. The mutation object is **never** put in a `useEffect`
dependency array.

### The agent page

`AgentDetailTabs` gains a **Conversations** tab (after Activity) rendering
`AgentConversationList` at page width — same rows, same order, rows link to
the thread. It answers "what is this agent working on right now, and where"
— the decision it drives is "open it or start another". Owner-only
telemetry stays on Activity; this tab is member-facing and scoped by the
same list rule. Not rendered for a system-managed agent (its page is
unreachable anyway).

### Threads inbox

`/threads` rows for a conversation thread show the thread title above the
message and link to `/channels/:id/threads/:threadId`; a General row is
unchanged.

### The conversation card

`components/features/channels/ConversationCard.tsx`, dispatched from
`ChannelMessageBody` in the row of `<AgentHandoffDoorway>` and the other
metadata cards (`readConversationRef(metadata)` safe-parses
`metadata.conversationRef`; anything else renders nothing). Data:
`useConversation(threadId, { refetchInterval })` under
`threadKeys.conversation(threadId)` — `WATCHING_POLL_MS` while `activeRun`
is set, `RAIL_POLL_MS` otherwise, `placeholderData: keepPreviousData`.
Several cards for one thread share the key, so a feed with five references
polls once.

It is the "little white card": `ChatCardShell` (`.chat-card` — `--panel`
paper, `--sep` hairline, `--radius-lg`, 42 rem max), the whole card one
`Link` to `/channels/:channelId/threads/:threadId` with the accessible name
"Open {title}", `data-testid="conversation-card"`. Inside, three rows with
spacing and no second frame:

1. **Header** — `IdentityTile` of the conversation's agent (the chat's
   small size), the title in `--tx` semibold, one line, ellipsis; right-aligned
   a status `Pill`, chosen structurally from the record:
   - `activeRun.status = running` → "Running" with a `--success` dot;
   - `pending` → "Queued" (`--tx3` dot);
   - `waiting_approval` → "Waiting for approval", `waiting_input` → "Needs a
     reply", both `--warn`;
   - no active run and `lastRunOutcome = completed` → "Done"; `failed` →
     "Failed" (`--danger`); `cancelled` → "Cancelled"; null → "Not started".
2. **Body** — one muted line (`--tx2`), ellipsis: while running,
   `progressLine` (this is "what it is doing right now" — the same thought
   ticker the thinking bubble shows, one line of it); otherwise
   `lastMessagePreview`; otherwise "Nothing said yet".
3. **Footer** — muted small: room (`#design` / "Direct message" / the agent's
   name for its DM) · relative time of `lastActivityAt` · `unreadCount` as an
   `UnreadBadge` when > 0 · right-aligned "Open →" in `--accent`.

States: loading → the shell with two `Skeleton` lines; 404 (not visible to
this viewer) → the withheld idiom the restricted-message placeholder uses
(dashed hairline, `--tx3`): "A conversation you can't see."; other errors →
the shell with "Couldn't load this conversation" and no link. A card never
shows a status the record did not state and never composes one from content.

"Step in" is the link: landing in the thread puts the person in the live
conversation with its thinking bubble, run gate and composer; a message sent
there while the run is in flight pends behind it (the existing serialisation),
which is exactly what stepping in means. No card-level cancel or reply: an
action that resolves would make it an `AgentCard`, and cancel already has its
door in the thread.

## Verification system

Every layer has a test that would fail without the change, run through the
package test scripts (never `tsx` directly), with `DATABASE_URL` exported
for the Turbo run. Tests scope every cleanup to their own seed and assert
no global count.

1. **Database, contract** — `api/test/agent-conversations-postgres.test.ts`
   (or `packages/team-admin/test/` if that package has a DB suite): seed org /
   team / project / a public channel, a private channel, users A (member of
   both) and B (member of the public one only), agent X bound to both.
   - A starts three conversations in the private room → three distinct
     threads, `agentId = X`, `startedByUserId = A`, titles derived; the
     channel's `defaultThreadId` is still General.
   - A's list: three conversations plus both General rows, newest activity
     first; B's list: the public General row only; B with X unbound from the
     public room and no other visibility → 404.
   - Personal Assistant: A's and B's PA DMs each hold a conversation; each
     person's list shows their own and not the other's.
   - `channelId` for a room X is not bound to → `channel_not_allowed`; a
     caller with no postable room → `no_room`; rename by B → 403, by A →
     200, of General → 400.
   - `lastMessagePreview` is null when the newest message carries a basis
     scope the viewer does not satisfy (seed one `message_basis_scopes` row).
   - `GET /api/threads/:threadId/conversation`: A gets the record; B gets 404
     for the private room's threads; `activeRun.progressLine` is the newest
     `run_thinking_chunks` content for a seeded `running` run and null when
     that run's basis is unreadable to the viewer (`run_basis_scopes` row);
     `lastRunOutcome` reflects a seeded terminal run.
2. **Database, isolation and concurrency** —
   `worker/test/db/agent-conversation-isolation.test.ts` beside
   `run-thread-serialization.test.ts`: two threads T1, T2 with `agentId = X`
   in one channel; `claimThreadRunOrPend` for each → two claimed runs, no
   pend; a further message on T1 → pends; `loadConversation(T2)` returns
   only T2's turns (sentinel strings in each thread).
3. **Orchestrator, unit** — beside the existing `orchestrate` tests: a
   top-level user message in a thread with `agentId = X` yields the
   structural decision (candidate X, placement `thread`, no engagement
   inference call — assert the mock model was not consulted); the same
   message in the General thread takes the existing path; an @mention of Y
   inside X's conversation adds Y.
4. **PA tool, unit** — `pa-tools/agent-conversations.test.ts`: resolves by
   name through the entitlement list; an invisible agent refuses in words;
   writes the opener through `createAgentMessage` with the computed basis;
   claims the run with `triggerMessageId` = the opener and `interactive:
   false`; unattended runs are admitted; the doorway message in the origin
   thread carries a valid `conversationRef` and is written in the same
   transaction as the opener (a failing claim leaves no doorway).
   `conversation_reference` refuses a thread outside the acting person's
   `buildViewerThreadWhere` in words, and an autonomous run's reference
   outside its own channel; a good one posts a message whose metadata parses
   as `ConversationRefMetadataSchema`.
5. **Browser, real stack** — `admin/e2e/agent-conversations/run.mjs`,
   script `test:e2e:agent-conversations`, modelled on `e2e/disclosure/`
   (real API + embedded worker + admin on the fixed ports, mock-LLM over
   HTTP). The mock scenario answers with the thread's own sentinel so
   replies are attributable. Cases, each screenshotted to
   `e2e/screenshots/agent-conversations/<case>/` on desktop, tablet and
   phone:
   - from the agent's DM, the rail shows Conversations; opening it lists the
     DM's General row;
   - New conversation twice → two rows, URL changes to each new thread, the
     composer is focused; send a distinct message in each → each reply
     arrives in its own thread and the other thread's messages are absent
     from the feed; the row of the running conversation shows the live dot;
   - the mock server's request log proves context isolation: every
     inference request's `messages` contain only its own thread's turns;
   - a second user who is not a member of the private room signs in and the
     API list for that agent does not contain those threads;
   - the card: in the Personal Assistant's DM a scripted assistant turn
     calls `agent_conversation_start` (the mock scenario's `toolCalls`) →
     a `conversation-card` appears in the DM reading "Running" with a
     progress line, then "Done" with the reply preview once the target's
     scripted run finishes; clicking it lands in that thread; both states
     screenshotted; the same card for the non-member user renders the
     withheld placeholder;
   - phone: header doorway → full-screen list → row → thread → Back returns
     to the list, Back again to the room.
   CI: a step in the Navigation Transitions job after the connected-mail
   suite, with an `agent-conversations-screenshots` artifact, gated on the
   same `steps.scope.outputs.code` as its neighbours.

## Docs and standards

- `docs/standards/reply-threads.md` gains a section "Container threads as
  conversations" stating the list rule, the structural-address rule and the
  `agentId: null` pin for General; `AGENTS.md` → "Architecture" gets its
  one-line routing sentence.
- `docs/standards/personal-assistant-tools.md` adds `agent_conversation_start`
  and `agent_conversations_list` to the route-mirroring list.
- `docs/standards/agent-cards.md` gains one paragraph at its boundary, beside
  the search card: the conversation card is presentational and live, rides in
  `metadata.conversationRef`, and is the reason a card kind per thing is
  still not needed.
- This file is updated to "as built" with anything that changed.

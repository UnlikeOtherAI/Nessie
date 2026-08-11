# Build plan — disclosure boundaries

**Status:** implementation plan, reviewed. Not yet started.
**Date:** 2026-08-11
**Design:** [2026-08-11-viewer-scoped-agent-knowledge.md](2026-08-11-viewer-scoped-agent-knowledge.md)
— read that for *why*. This document is *what to build and in what order*.

---

> ## ⚠ Amended after third review — read this before the work packages
>
> A third review (Codex Sol) found that **a message-only basis cannot enforce the
> boundary**, and that the "security cut" below does not close the leak. Three
> findings, all verified:
>
> **1. Content is laundered into unrestricted memory within one run.**
> `loadThreadTail` ([`consolidate.ts:262`](../../packages/memory/src/consolidate.ts#L262))
> selects thread messages by raw SQL with no filter, and consolidation writes the
> result back as a **`channel`-audience thought**
> ([`consolidate.ts:350`](../../packages/memory/src/consolidate.ts#L350)). A
> restricted reply therefore becomes ordinary channel memory that feeds
> *everyone's* future prompts through `user_shared` recall. The message predicate
> never sees it. `send_message`'s capture at
> [`message-delivery.ts:64`](../../worker/src/run/pa-tools/message-delivery.ts#L64)
> does the same — this document previously called that path "untouched (good)",
> which was wrong.
>
> **2. Basis does not survive derivation — the one-turn laundering hole.**
> `loadConversation` returns content but no basis. So when the entitled asker
> says *"summarise that"*, the reply is built from the **transcript**, not from
> retrieval; its computed basis is empty; and the resulting message is
> unrestricted. One turn erases the boundary, and no work package below closed it.
> **Basis must propagate through derivation:** a reply's basis is the union of its
> retrieval basis **and** the basis of every transcript turn admitted into its
> window. `loadConversation` must return basis alongside content.
>
> **3. The boundary must attach to derived artifacts, not only messages.**
> Verified readers that materialise message content elsewhere and serve it on
> different access rules: thinking chunks
> ([`thinking-recorder.ts:55`](../../worker/src/run/execute/thinking-recorder.ts#L55),
> returned to any thread viewer via
> [`threads.ts:82`](../../api/src/routes/threads.ts#L82)); `ToolCall.outputPreview`
> carrying KB page bodies ([`tool-events.ts:38`](../../worker/src/run/execute/tool-events.ts#L38))
> served by `/agents/:id/activity`; `/api/agents/:id/messages` returning
> `fullContent` ([`agent-read-model.ts:289`](../../api/src/services/agent-read-model.ts#L289));
> trigger content copied into `Task.purpose` where project-null tasks are
> org-visible; reply text copied into plan artifacts and workflow outputs
> ([`completion.ts:150-163`](../../worker/src/run/execute/completion.ts#L150));
> and attachment bytes authorised by channel visibility alone.
>
> Consequences for the plan: **WP1 grows** to carry transitive inheritance,
> **WP2 is re-specified** (see its note — the SSE citation was wrong), **WP0
> grows** to cover four more create paths and message *edits*, and a new
> **WP2.5 — derived-artifact containment** becomes part of the security cut.
> The revised cut is stated at the end.

## The one thing to get right first

**Every agent-originated post must go through one stamping chokepoint before any
read-side predicate is written.** There are **five** paths that create
agent-originated messages today:

| Path | What it posts |
|---|---|
| [`completion.ts:67`](../../worker/src/run/execute/completion.ts#L67) | the normal reply — *and* a delegated-PA branch that posts as `role: 'user'` |
| [`cancel-stop.ts:97`](../../worker/src/run/execute/cancel-stop.ts#L97) | partial text from the same privileged window |
| [`failure.ts:41`](../../worker/src/run/execute/failure.ts#L41) | error notices |
| [`budget-gate.ts:22`](../../worker/src/run/execute/budget-gate.ts#L22) | budget-block messages |
| [`message-delivery.ts:46`](../../worker/src/run/pa-tools/message-delivery.ts#L46) | `send_message`, mid-run |

Stamping only the first closes the front door and leaves four side doors emitting
content drawn from the identical context. **WP0 exists so this cannot happen.**

**Four more create paths, found in the third review** — verify each before
declaring the set closed:
[`external-conversation.ts:263`](../../worker/src/run/external-conversation.ts#L263),
[`comms-card.ts:44`](../../worker/src/run/pa-tools/comms-card.ts#L44),
[`orchestrate.ts:104`](../../worker/src/run/orchestrate.ts#L104), and
agent-to-agent delivery at
[`mailbox.ts:258`](../../worker/src/control/mailbox.ts#L258).

**And creation is not the only mutation.** `message_edit`
([`agent-messages.ts:117`](../../worker/src/run/pa-tools/agent-messages.ts#L117))
can replace the content of an existing zero-basis message with privileged text
and leave it unstamped. WP0 therefore needs a **stamped content-replacement**
operation, not only a stamped create.

**Do not build one function taking arbitrary Prisma `data`** — the five paths
differ in role, `userId`, `metadata`, `rootMessageId`, and reply bookkeeping, and
a single entry point becomes parameter soup. The shape that holds:

1. `persistMessageWithBasis(tx, draft, inheritedBasis)` — small, transactional.
2. Discriminated draft composers for `assistant` and `delegated_user` authorship.
3. Separate run-terminal and delegated-send coordinators owning their own
   post-commit effects.
4. A stamped content-replacement operation for edits.

Note the delegated-PA branch: it posts agent-generated content with
`role: 'user'`. A predicate keyed on *agent-authored* rows would miss it
entirely, so the predicate must also match `metadata.delegatedByAgentId` — a
structural field, not a content heuristic.

---

## Constraints

- Prisma migrations are immutable once committed. `pnpm lint:migrations` warns on
  non-`CONCURRENTLY` index creation on `messages` / `task_events` / `runs` /
  `audit_logs`.
- 500-line cap. At the touch points: `orchestrate.ts` **467**,
  `api/src/services/messages.ts` **487**, `prompt.ts` 234, `completion.ts` 184.
  Two of these require extraction, not appending.
- DB tests are seed-scoped: never a global `messages` count, never a global
  mutation (`AGENTS.md` → Workflow). Export `DATABASE_URL` for the Turbo run.
- Rebuild the worker after worker changes; the API runs it embedded from `dist`.
- Every UI change verified with Playwright headless at `http://localhost:5455`.
- Docs updated in the same turn as behaviour.

---

## WP0 — one stamped-post chokepoint  ·  size M

**No schema.** Pure refactor, shippable alone, changes no behaviour.

Create `worker/src/run/execute/agent-message.ts` exporting
`createAgentMessage(deps, context, input)`. Route all five paths above through
it. It owns the `prisma.message.create` and, from WP1, the basis inserts in the
same transaction.

**What must stay outside that transaction** — verified, and getting this wrong
silently rolls back run state on a basis-computation failure:

- `publishSse` ([`completion.ts:91`](../../worker/src/run/execute/completion.ts#L91)) —
  writes `thread_stream_events` by raw SQL plus `LISTEN/NOTIFY`
  ([`packages/runtime/src/realtime.ts:233`](../../packages/runtime/src/realtime.ts#L233));
  listeners must never see an uncommitted message id.
- `publishMessageCreated` (`:96`), mention alerts (`:107`), `updateRunStatus`
  (`:130`), `enqueueRunMemoryConsolidation` (`:134`),
  `drainPendingThreadMessagesBestEffort` (`:172`).
- `applyRunReplyBookkeeping` (`:93`) sits outside the create today — leave it
  there; keep the diff minimal.

`captureUserMessageMemory` is **not** in `completion.ts` (it lives in
[`message-delivery.ts:65`](../../worker/src/run/pa-tools/message-delivery.ts#L65)) and is
untouched.

**Tests:** each of the five paths produces a message through the chokepoint;
realtime/alerts/status still fire after commit; a thrown basis computation rolls
back the message but not the run's terminal state.

---

## WP1 — `MessageBasisScope` + write-side stamping  ·  size M

**Migration** `add_message_basis_scopes` — new table only, no index on
`messages`, so the lint warning does not apply:

```sql
CREATE TABLE message_basis_scopes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id      uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scope_type      text NOT NULL,     -- user|channel|team|project|organization
  scope_id        uuid NOT NULL,
  created_at      timestamp(3) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX message_basis_scopes_unique
  ON message_basis_scopes(message_id, scope_type, scope_id);
```

**New** `worker/src/run/execute/disclosure-basis.ts` (~180 lines):
`computeReplyBasis(consumedSources, destinationChain)` returning only scopes
**not implied by** the destination's chain; `resolveDestinationScopeChain`,
memoised per run.

**Consumed-source accumulation: a per-run sink on `RunContext`** — both reviewers
independently recommended this over the tool dispatcher, which is shared across
runs. Memories already arrive in the right shape at
[`run-setup.ts:127-131`](../../worker/src/run/execute/run-setup.ts#L127); the
`kb_*` handlers write their space verdict into the sink at the point they already
compute it ([`knowledge.ts:138`](../../worker/src/run/pa-tools/knowledge.ts#L138)).

**Ships alone, deliberately.** Write-only stamping changes no read behaviour, so
it is safe to land early — and every day it runs shrinks the pool of unstamped
legacy messages before any predicate turns on.

**Tests:** org-tier-only run stamps nothing; project memory into an out-of-chain
channel stamps; in-chain does not; computation failure posts nothing. Assert on
the suite's own `message_id`/thread — **never** a global `messages` count.

---

## WP2 — close the wire  ·  size M  ·  **blocking**

Not in the original plan. Both reviewers independently identified it as the most
live leak, and it is not fixed by any read-side predicate.

[`realtime.ts:76`](../../worker/src/run/execute/realtime.ts#L76) publishes
`contentPreview: input.content.slice(0, 200)` to channel/org scopes
([`scopes.ts:21`](../../worker/src/run/execute/scopes.ts#L21)). The first 200
characters of a restricted reply reach **every connected channel member** the
instant it is written. The SSE stream (`stream.done`, and live reasoning deltas)
carries full content on the same basis.

**Fix:** for a message with a non-empty basis, publish **content-free** —
`messageId`, `threadId`, `role`, and a `restricted: true` marker — and let
entitled clients refetch through the WP3 predicate.

**Correction from the third review:** an earlier draft said per-viewer SSE
filtering would be possible later, citing the per-user global event stream. That
was the wrong stream. The *thread* SSE registers with `thread.id` only —
`realtimeHub.addSseConnection(thread.id, reply.raw, lastEventId)`
([`threads.ts:395`](../../api/src/routes/threads.ts#L395)) — so there is no
viewer to filter on without re-architecting the hub. **Content-free push is not
the first move, it is the only move** available at this cost.

**Live text precedes the message.** Reasoning and reply deltas stream from
[`run-inference.ts:98`](../../worker/src/run/execute/run-inference.ts#L98) before
any message row or basis exists. Streaming to a thread-scoped connection
therefore cannot be gated by a message predicate at all. Until the hub carries a
viewer, **a run whose retrieval basis is non-empty must not stream deltas** —
it posts its reply on completion instead. The thinking bubble degrades to a
content-free "working" state for those runs.

**Mention alerts are part of this WP.** `createMessageMentionAlerts`
([`completion.ts:107`](../../worker/src/run/execute/completion.ts#L107)) writes a
durable `UserAlert` and pushes it to every mentioned user regardless of basis. A
restricted reply mentioning a non-entitled person hands them an alert and a
doorway. Suppress the alert row for recipients who fail the basis predicate.

---

## WP2.5 — derived-artifact containment  ·  size L  ·  **in the security cut**

Added by the third review. A message-only basis does not hold, because content is
materialised into other stores that serve it on different rules.

**Must be closed before the cut is claimed:**

| Artifact | Where | Fix |
|---|---|---|
| Consolidated memory | [`consolidate.ts:262`](../../packages/memory/src/consolidate.ts#L262) unfiltered tail → [`:350`](../../packages/memory/src/consolidate.ts#L350) channel-audience thought | Inherit basis onto the thought's audience, or skip restricted candidates entirely |
| `send_message` capture | [`message-delivery.ts:64`](../../worker/src/run/pa-tools/message-delivery.ts#L64) | Same |
| Thinking chunks | [`thinking-recorder.ts:55`](../../worker/src/run/execute/thinking-recorder.ts#L55), served by [`threads.ts:82`](../../api/src/routes/threads.ts#L82) | Gate the read on the run's basis |
| Tool output previews | [`tool-events.ts:38`](../../worker/src/run/execute/tool-events.ts#L38) → `/agents/:id/activity` | Gate on the run's basis |
| Agent message read model | [`agent-read-model.ts:289`](../../api/src/services/agent-read-model.ts#L289) `fullContent` | Apply the message predicate |
| `Task.purpose` | [`orchestrate.ts:321`](../../worker/src/run/orchestrate.ts#L321); project-null tasks are org-visible | Do not copy trigger content, or carry basis |
| Plan artifacts / workflow output | [`completion.ts:150-163`](../../worker/src/run/execute/completion.ts#L150) | Carry basis or omit content |
| Attachment bytes | [`attachments.ts:46`](../../api/src/services/attachments.ts#L46) | Authorise on the owning message's basis, not channel visibility alone |

Prefer **skip-if-restricted** over **inherit** wherever the artifact has no
natural audience to carry a basis. Inheriting is more capable; skipping is
smaller and fails closed. Decide per row, record which.

## WP3 — the read predicate  ·  size L  ·  **riskiest**

Split into three landable changes; a missed reader silently re-opens the leak.

**New** `packages/runtime/src/disclosure-predicate.ts` (~150 lines) — shared by
API and worker. Not a new package: 150 lines does not justify one, and `runtime`
already hosts the cross-cutting seams. Matches agent-authored rows **and**
`metadata.delegatedByAgentId` rows.

**WP3a — worker reads.**
1. [`prompt.ts:190`](../../worker/src/run/execute/prompt.ts#L190) `loadConversation`
   gains a **required** `viewer`. Exactly one production caller
   ([`run-setup.ts:121`](../../worker/src/run/execute/run-setup.ts#L121)), so
   nothing breaks. Type it as a discriminated union —
   `{ kind: 'user', userId }` | `{ kind: 'autonomous' }` — so the autonomous case
   is named rather than nullable. **Open decision below: what an autonomous run
   may see.**
2. `orchestrate.ts` — extract **both** message reads into
   `worker/src/run/orchestrate-context.ts` (file is at 467/500): the engagement
   window at [`:171`](../../worker/src/run/orchestrate.ts#L171) *and* the
   `followingAgentIds` author scan at
   [`:208`](../../worker/src/run/orchestrate.ts#L208). Only the first carries
   content and needs the predicate; the second selects `agentId` only. Extract
   both for cohesion, filter the first. Reviewers split on whether the second
   leaks — it does not leak content, but it does let a prior restricted exchange
   influence engagement, so record the decision explicitly rather than leaving it
   implicit.
3. [`checkpoint.ts:51`](../../worker/src/run/execute/checkpoint.ts#L51) — the
   claim query, once WP4 supplies something to filter on.

**WP3b — API reads.** `listThreadMessages`
([`messages.ts:231`](../../api/src/services/messages.ts#L231)). The file is at
**487/500**, so extract the query layer rather than appending.
`ThreadMessageRecord` in `api/src/contracts/messaging.ts` gains a
`restricted` marker so the client can render the placeholder — the contracts
layer was missing from the first draft, and the desktop shell inherits it.

**WP3c — search.** `searchMessages`
([`messages.ts:392`](../../api/src/services/messages.ts#L392)) is a **raw SQL
`to_tsvector` path with its own channel scoping** — a Prisma `where` fragment
cannot be applied. It needs its own basis anti-join in SQL. Same for the PA
`conversation-search` tool
([`worker/src/run/pa-tools/conversation-search.ts`](../../worker/src/run/pa-tools/conversation-search.ts)).

---

## WP4 — checkpoint basis  ·  size M

**Migration** `add_run_checkpoint_basis_scopes`, same shape as WP1 keyed on
`run_checkpoint_id`.

**The mechanism from the first draft was unimplementable** and both reviewers
caught it. "Union of the bases of the turns it compacted" cannot be built:
`ProviderMessage` carries no per-turn basis, and compaction
([`context-compaction.ts:157`](../../worker/src/run/context-compaction.ts#L157))
folds turns into a note that lives only in the model context. The checkpoint note
is a *separate* model call
([`run-stop.ts:60`](../../worker/src/run/execute/run-stop.ts#L60)) rendered from
the post-compaction window, so compaction feeds checkpoints only transitively.

**Correct mechanism:** persist the **run-level consumed-sources union** from
WP1's sink at `persistRunCheckpoint`
([`checkpoint.ts:128`](../../worker/src/run/execute/checkpoint.ts#L128)).
Strictly conservative, needs no per-turn provenance, and covers every route by
which privileged content reaches a checkpoint — including the memory-context
system message, which retrieval-only stamping would miss even without compaction.

---

## WP5 — withheld placeholder  ·  size S

Worker: `prompt.ts` renders withheld turns as a fixed server-authored line and
skips their images and attachment inventory lines, without disturbing the prompt
builder's "is the trigger already the last turn?" check.

Admin: [`ChannelMessageRow.tsx`](../../admin/src/components/features/channels/ChannelMessageRow.tsx)
renders the placeholder and the "Restricted sources" chip. One component, already
shared by the feed and the thread panel — do not fork it.

---

## WP6 — `restricted` thoughts  ·  size S  ·  independent

[`packages/retrieval/src/thoughts.ts:29`](../../packages/retrieval/src/thoughts.ts#L29)
selects `sensitivity_tier` and never filters; the SQL `match_thoughts_*` functions
do the same. Exclude `restricted` thoughts from cross-scope injection, matching
the KB semantic. Ships any time — an afternoon.

**Rule zero:** this is a machine-only change with no surface. Recorded here as a
deliberate decision rather than an oversight.

---

## WP7 — the card, Deny / Allow-once  ·  size M

`DisclosureGrant` migration; `POST /api/messages/:id/disclosure-grants` +
`DELETE`. Human session only — agent actors 403 + audit. The caller must
currently pass the message's full basis predicate, verified in the same
transaction as the insert. `UserAlert` to entitled scope members when nobody
present can answer. Admin: the chip becomes actionable.

## WP8 — standing grants + duration menu  ·  size L

`ScopeDisclosureGrant` unique on `(sourceScope, destination, agent)`; evaluation
joins the granter's **current** source-scope membership so a grant goes inert on
membership loss. Tier-capped durations enforced **server-side**, 422 on a crafted
out-of-ceiling request. Admin: dropdown, channel Disclosures panel, org list under
Settings → Privacy. The 14-case non-widening suite from the design doc.

## WP9 — knowledge-base sharing  ·  size L

`KnowledgeShare` migration. **Correction to the first draft:** there is no
`canReadPage` — the read gate is `canReadSpace`
([`access.ts:103`](../../packages/knowledge/src/access.ts#L103)) and the agent
humans-only denial is `canAgentReadSpace` at
[`:90`](../../packages/knowledge/src/access.ts#L90). Critically, that rule is
**mirrored in SQL** ([`native-search-access.ts`](../../packages/knowledge/src/native-search-access.ts),
whose own comment says *keep the two in lockstep*), so shares honoured only in
TypeScript would be invisible to KB search and page listing
(`native-recent-pages.ts`). All three surfaces need the share check.

Folder cascade over the live tree; link-drop creating a recorded share with a
non-blocking notice and undo; unified not-found/no-access response; the Access
panel — the **same component** as WP8's Disclosures list.

**Link detection is structural and permitted.** Parsing a URL against our own KB
route pattern acts on the link's destination, not on what the message means — the
same class as the explicit-@mention fast path. Keep a justifying comment.

## WP10 — member-add warning  ·  size S

Adding a member to a channel carrying live grants names the count and that
history is included. Counts, never contents.

## WP11 — Part 3 remainder  ·  size M

Deferred but recorded so it does not vanish: `agent_messages` predicate,
basis chaining through the `promptOverride` writers (mailbox send, subtask
spawn), and the standalone `attachment_read` entitlement check.

---

## Sequencing

```
WP0 ─→ WP1 ─→ WP2 ─→ WP2.5 ─→ WP3a ─→ WP3b ─→ WP3c ──┐
                                                       ├─→ WP4 ─→ WP5
WP6 (any time) ───────────────────────────────────────┘
                                     WP7 ─→ WP8 ─→ WP9 ─→ WP10 ─→ WP11
```

**Revised security cut: WP0 + WP1 (with transitive inheritance) + WP2 + WP2.5 +
WP3a + WP3b.** The earlier cut (WP0–WP3a) was shown not to close the leak — three
concrete escapes survived it:

1. **The API still served it.** WP3b was scheduled later, so a non-entitled viewer
   could simply call `GET /api/threads/:id/messages`
   ([`threads.ts:40`](../../api/src/routes/threads.ts#L40) →
   [`messages.ts:231`](../../api/src/services/messages.ts#L231)) and read full
   content. WP3b is therefore **inside** the cut, not after it.
2. **Live text preceded the message** (see WP2's note) — no message, no basis,
   nothing to predicate on.
3. **One turn laundered it.** A's "summarise that" produced a zero-basis reply
   from restricted transcript content, which B's window then admitted. Closed
   only by WP1's transitive inheritance.

WP3c, WP4 and WP5 follow within days as correctness and UX. WP7 onward is the
consent product, built on a boundary that by then actually holds.

Each WP is one landable change. WP3 is explicitly three.

---

## Open decisions

1. ~~**What may an autonomous run see?**~~ **Resolved by the third review, on
   evidence:** use the saved trigger owner when one exists, otherwise
   zero-basis-only. User-created schedules already carry an immutable
   `createdByUserId`/`launchOrigin`
   ([`trigger-origin.ts:39`](../../worker/src/control/trigger-origin.ts#L39)),
   already revalidate active org/team membership at fire time
   ([`:104`](../../worker/src/control/trigger-origin.ts#L104)), and already place
   that identity in `actorContext.actionContext.effectiveUserId`
   ([`trigger-run.ts:275`](../../worker/src/control/trigger-run.ts#L275)) — where
   memory retrieval already treats it as `user_shared`
   ([`memory.ts:111`](../../worker/src/run/execute/memory.ts#L111)). So the
   viewer resolves as `effectiveUserId → user viewer`, and only genuine
   `userId: null` automation ([`trigger-origin.ts:96`](../../worker/src/control/trigger-origin.ts#L96))
   becomes autonomous. Entitlements resolve live from the user id — **never** from
   the stored project/team tuple, which is last-seen metadata. This makes the
   disclosure boundary consistent with recall, which already behaves this way.
2. **Denormalised `has_basis` on `messages`?** Reviewers split. **Decision: no,
   not in v1** — an anti-join on an indexed FK at `take: 20` is cheap, search
   needs its own SQL mechanism regardless, and WP2 removes realtime from the hot
   path by not publishing content at all. Adding a column to `messages` also
   requires `CREATE INDEX CONCURRENTLY` to clear the migration lint. Revisit
   behind a measured p95 regression, not in anticipation of one.
3. Do the `followingAgentIds` semantics change (WP3a item 2)? Recorded as an
   explicit decision either way.

## Review record

Reviewed 2026-08-11 by **Fable** and **Kimix** independently; every claim
re-verified against the tree before acceptance.

Both found, independently: the five-path stamping gap (WP0 — verification added
`budget-gate.ts:22`, which neither named); realtime push as the blocking leak
(WP2); WP4's mechanism as unimplementable; `canReadPage` not existing; the
contracts layer missing; `packages/runtime` as the predicate's home; the per-run
sink; `viewer` required with the autonomous case named; WP9's URL parse as
structural and permitted.

Found by one and confirmed: the mention-alert leak and the second `orchestrate.ts`
read (Kimix); the delegated-PA `role: 'user'` predicate gap and the
`messages.ts` 487-line cap risk (Fable).

Split and adjudicated: the `has_basis` denormalisation — see Open decision 2.

**Third review (Codex Sol), on the corrected document.** Found what the first two
and I all missed: that a message-only basis cannot enforce the boundary at all.
Its three structural findings — memory-consolidation laundering, one-turn
derivation laundering, and the derived-artifact readers — are verified above and
produced WP2.5, the WP1 transitive-inheritance requirement, the WP2 correction,
and a redefined security cut. It also resolved Open decision 1 from evidence
rather than opinion.

**Highest-value single test**, per that review — the hole most likely to ship
silently: a three-turn Postgres test where A causes a P-derived reply `m1` in
channel C; A then asks *"summarise that"* **with retrieval disabled**, so the only
possible source is the transcript; assert `m2` inherits P's basis; then assert B's
follow-up receives placeholders for both. Repeat with `send_message` triggering a
second agent. Without transitive inheritance this passes turn one and fails turn
two — which is exactly how it would have reached production.

## Changelog

- **2026-08-11** — Created from a reviewed draft; WP0 and WP2 added as a direct
  result of review, WP4's mechanism corrected, WP3 split into three.
- **2026-08-11** — Amended after a third review: WP2.5 added (derived-artifact
  containment), WP1 extended to transitive basis inheritance, WP0 extended to four
  further create paths plus message edits, WP2's SSE architecture corrected and
  streaming restricted, the security cut redefined to include WP3b, and the
  autonomous-viewer decision resolved.

# Agent documents — the docs an agent keeps for itself

**Status:** implementation in progress — Phase 1b access arm implemented;
provisioning, disclosure, tools, prompt, and UI remain separate phases.
**Date:** 2026-08-31
**Related:**
[2026-08-31-agent-tables.md](2026-08-31-agent-tables.md) (agent-owned typed
rows; this design reuses its ownership/visibility verdicts),
agent to-dos (branch `docs/agent-todos`,
`docs/plans/2026-08-31-agent-todos.md` — the Designer-tab and
audience-superset patterns),
[2026-08-30-agent-scopes-personal-team-global.md](2026-08-30-agent-scopes-personal-team-global.md)
(`Agent.visibility` — still a proposal; in-flight on `feat/agent-scopes`),
[2026-08-29-people-and-their-agents.md](2026-08-29-people-and-their-agents.md)
(ownership = stewardship, landed),
[2026-08-13-live-document-streaming/overview.md](2026-08-13-live-document-streaming/overview.md)
(the compose/edit primitive this design rides),
[2026-08-11-viewer-scoped-agent-knowledge.md](2026-08-11-viewer-scoped-agent-knowledge.md)
+ [2026-08-11-disclosure-boundaries-build.md](2026-08-11-disclosure-boundaries-build.md)
(the provenance rules every read/write here obeys).

## The idea

An agent should be able to **author and keep its own documents** — working
notes, reference material, drafts, research digests, its own SOP prose — and
re-read them across runs. The agent writes them, edits them, and organizes
them; the people who can see the agent can read them (and edit them, like a
colleague's shared notebook); a private agent's documents stay exactly as
private as the agent. This is the prose sibling of agent tables ("tabulate
facts you'll filter and count") and agent to-dos ("deterministic checklists"):
**document what you'll re-read, maintain, or hand to a colleague; remember
impressions; tabulate facts; check off steps.**

## 0. The verdict first: this is a Knowledge Base extension, not a new store

The task asked whether agent documents are an extension of the KB or a
sibling store. The code answers it. Verified against `main`, 2026-08-31
(three parallel sweeps: KB model + tools, ownership/visibility predicates,
streaming/memory/disclosure):

**Everything a "document" needs already exists in the KB, agent-shaped:**

- **Versioning** — `KnowledgePageVersion` is append-only with
  `versionNumber`, `changeComment`, and per-revision
  `authorType ∈ {user, agent}` + `authorId` (`schema.prisma:4160`). Agents
  and humans already interleave revisions on one page; `restoreVersion`
  exists.
- **Agent authorship** — every agent write already stamps
  `('agent', agentId)`: `resolveAuthor` in
  `worker/src/run/pa-tools/knowledge-write.ts` deliberately decouples
  authorship from the access principal.
- **Agent privacy hooks** — `privateToAgentId` on `KnowledgeSpace`,
  `KnowledgePage`, and (denormalized) `KnowledgePageChunk`;
  `KnowledgeSpaceMember.agentId` grants a space to an agent; and
  `packages/knowledge/src/access.ts` already treats
  `space.createdBy === agent.id` as an explicit agent grant — an
  agent-created space is *de facto* agent-owned today.
- **The write primitives** — `kb_document_compose` (streaming markdown →
  `kind: 'file'` page + Attachment through the one `FileService`),
  `kb_document_edit` (`{find, replace}` deltas), `kb_draft_write`,
  `kb_file`, `kb_publish_request`. All are plain builtins available to every
  agent (none is `personalAssistantOnly` or `requiresExplicitGrant`).
- **The read primitives** — `kb_search` (hybrid lexical+vector over
  `knowledge_page_chunks`, access-filtered inside the SQL via
  `readableSpaceIdsSqlForViewer` + `chunkPrivacyWhere`), `kb_page_read`,
  `kb_list` — each already feeding the disclosure sink through
  `recordKnowledgeSpaceRead` (`worker/src/run/pa-tools/knowledge-basis.ts`).
- **The per-principal home-space precedent** — `ensureMyDocsSpace`
  (`api/src/services/knowledge-provisioning.ts`): one advisory-locked,
  idempotent, metadata-tagged private space per user. The agent edition of
  this function is most of phase 1.
- **The human surface** — the knowledge workspace UI, which Rule zero itself
  cites as the reuse exemplar ("as the project Docs tab reuses the knowledge
  workspace").

A separate agent-doc store would have to re-implement every row of that list
— a second version model, a second chunk/embedding pipeline, a second
FileService wiring, a second streaming save handler, a second reader UI. The
streaming machinery sweep confirmed the recorder lanes, scanners, edit
tracker, SSE events, and the entire admin popup are destination-agnostic, but
the KB coupling points (`document-stream.ts` mode switch, `RunDocumentSession`
columns, `readMarkdownDocument`, the target bar) mean a new store still pays a
generalization tax for zero functional gain. The agent-tables plan already
drew this boundary from the other side: *"Not a second knowledge base.
Documents and files stay in KB."* Same rule, read forward: **agent documents
are KB pages in an agent-owned space.** What is genuinely missing is exactly
one fact and one predicate arm: *a space owned by an agent, readable by
whoever can see that agent.*

(Also for clarity: `document_read` from the task brief is unrelated — it
greps the repo's own `docs/**/*.md` from disk
(`worker/src/run/content-tools.ts`); it plays no role here.)

## 1. What exists today — the load-bearing facts

Beyond §0, the facts this design composes with, each verified:

- **Agent visibility is entitlement through channels plus ownership.**
  `listAgentsForUser` / `isAgentVisibleToUser` / `isAgentAccessibleToActor`
  (`packages/workspace-admin/src/agent-list.ts:31`, `access-checks.ts:54,88`)
  = bound into a channel the viewer can see OR stewarded
  (`buildOwnedAgentWhere`: live membership + `parentAgentId: null`); org
  owners see every non-system agent. `Agent.visibility`
  (`workspace | private`) is **proposed, not merged** — in-flight on
  `feat/agent-scopes` with `buildAgentVisibilityWhere` composed into the
  mirror pair. This design, like to-dos, gates every read through the mirror
  pair so the private fragment is inherited with zero changes here.
- **KB space access** (`packages/knowledge/src/access.ts`): user arm =
  creator / org-visibility / project membership / explicit
  `KnowledgeSpaceMember`; `private` and `channel`/`team` visibilities admit
  users only by explicit membership. Agent arm = `restricted` tier denies
  outright, then explicit grant (`privateToAgentId` / `createdBy` /
  membership), then binding-derived reach. The SQL mirror is
  `native-search-access.ts`.
- **Publish discipline**: agent-authored pages land `draft`; direct publish
  by an agent is 403 at the API; `kb_publish_request` creates the
  `ApprovalRequest`. The one exception: `kb_document_compose` into a
  `visibility: 'private'` space auto-publishes, because the requesting
  person is the only reader and just watched it stream.
- **Disclosure**: every KB read records the space's scope via
  `scopeForVisibility` into `ConsumedSourceSink`; `computeReplyBasis`
  subtracts destination-implied scopes; `agent-message.ts` stamps the rest.
  An empty basis means unrestricted — the read carries the obligation.
  `privateToAgentId` is deliberately *not* a basis scope (basis vocabulary
  describes audiences of people). Containment constrains memory recall only.
- **Memory is a different substance.** `thoughts` are system-written
  (consolidation job, user-message capture), sentence-grained, implicitly
  recalled top-5 truncated to 220 chars, never agent-addressable — there is
  **no** `memory_*` tool at all. Documents are the deliberate, stable,
  whole-artifact counterpart. §7 states the boundary for tool descriptions.
- **A known gap, inherited and named**: the document stream lanes publish
  `stream.document.start/meta/delta/edit` with **no `runReplyIsRestricted`
  gate**, unlike `stream.delta` and the thinking lane, and the
  bootstrap route is gated by thread membership only. A document composed
  after the run consumed a privileged source streams in full to every thread
  viewer today. §5 makes closing this part of this work.

## 2. The model — one new fact, everything else reused

### 2.1 `KnowledgeSpace.ownerAgentId` and the per-agent home space

```prisma
// KnowledgeSpace gains:
ownerAgentId String? @map("owner_agent_id") @db.Uuid   // FK → agents, ON DELETE RESTRICT
ownerAgent   Agent?  @relation("AgentDocsSpaces", fields: [ownerAgentId], references: [id], onDelete: NoAction)
@@index([organizationId, ownerAgentId])
```

- A space with `ownerAgentId` set is an **agent-owned space**: the agent is
  its proprietor, and its human audience is derived from the agent at read
  time (§4). One agent gets one *home* space (plus folders inside it), but
  the column is a general fact, not a singleton rule — a later feature may
  let an agent own more than one.
- **The home space** is provisioned by `ensureAgentDocsSpace(agentId)` —
  the `ensureMyDocsSpace` pattern verbatim: advisory-locked on
  `(agentId, 'agent_docs')`, idempotent, `name: '<Agent name> — Documents'`,
  `metadata: { agentDocs: true }`, `createdBy: agentId`, and crucially
  **`visibility: 'private'` with no `userId`**. That visibility is the
  fail-closed floor: no *existing* user-side arm admits anyone (the creator
  arm compares against an agent id; `private` admits only explicit members),
  so if any future read path composes the old predicates and forgets the new
  arm, an agent's documents are invisible rather than public. The new arm
  (§4) is the sole widener. A CHECK keeps the shape honest:
  `owner_agent_id IS NULL OR visibility = 'private'`.
- **Provisioned lazily at run setup**, not at agent creation: when a run's
  toolset includes any KB write tool, run setup does one indexed SELECT for
  the agent's home space and creates it only if absent (so agents that never
  run never mint rows). The resulting space id feeds the structural prompt
  block (§3). Sub-agent (`spawn_subtask`) children get **no home of their
  own**; they read and write the parent's (§4).
- **The PA gets no agent-docs space.** PA-authored documents already belong
  to the person: the PA writes with the owner's principal into the owner's
  **My Docs** — the same "PA artifacts belong to the person, not the
  singleton" verdict agent-tables reached. The ensure function refuses
  `systemManaged` rows; nothing else changes.
- **Steward is read through the agent, never copied.**
  `Agent.ownerUserId` is one JOIN away via the new FK, so the docs space has
  no `owner_user_id` column: transfer of the agent moves its documents'
  stewardship automatically, and there is no second copy to drift. (This
  deliberately diverges from agent-tables, which copies `owner_user_id` at
  creation; tables did so to get a composite tenancy FK on a table with no
  agent FK requirement. Here the agent FK exists anyway, so the copy would
  be a second statement of one fact. If the team prefers symmetry with
  tables, copying is workable — but then transfer must update it, which is
  new machinery. Read-through is recommended.)

### 2.2 A document is a `KnowledgePage`, unchanged

No new page-level entity, column, or kind:

- **Markdown documents** (the primary shape) are `kind: 'file'` pages with
  `.md` attachments — exactly what `kb_document_compose` produces, watchable
  live, editable by deltas, versioned per revision.
- **Rich-text pages** via `kb_draft_write` work identically; an agent that
  prefers HTML pages over markdown files loses only the live-streaming
  popup.
- **Folders** are what they already are: a `document` page with children;
  `kb_file` reorganizes. No collections table.
- **Versioning, labels, wikilinks, annotations, chunks/search** — all
  inherited untouched. Humans commenting on an agent's doc use the existing
  `kb_comment_*` machinery, and the agent reads those comments back with the
  same tools.

Inside an agent-owned space the two agent-authorship guards relax
coherently: `kb_file`'s "only draft pages you authored" check and the
draft-reset-on-update behaviour keep their current semantics everywhere
else, but in the agent's own space the agent is the proprietor — see §5 for
exactly which publish rules change and which do not.

### 2.3 What is deliberately NOT built

- **No new store, no new page entity, no `agent_documents` table.** (§0.)
- **No second streaming stack** — `kb_document_compose`/`kb_document_edit`
  are already the primitive; no `docs_compose` fork of the recorder.
- **No new tool family** (§3) — the `kb_*` tools already speak this domain;
  a parallel `docs_*` vocabulary would be the TabBar defect for tools.
- **No stored audience copy** — never materialize "who can see the agent"
  into `KnowledgeSpaceMember` rows; the audience is computed at read time
  (the tables `inherit` rule; a synced copy is the drift machine both
  sibling designs reject).
- **No per-document agent ACLs** in v1 — the space is the unit of agent
  ownership; `privateToAgentId` on individual pages elsewhere keeps its
  current meaning and current non-use by tools.

## 3. How agents use their documents — tools reused, addressing added

The tool surface is the existing one. What is new is that the agent can
*address* its home without inventing a spaceId, plus the ownership-aware
behaviour of each tool inside it:

- **A structural prompt block** (facts from run setup, never message
  content — the research-routing-block precedent): *"Your documents live in
  space `<id>` ('<name>'). Use `kb_list`/`kb_search` to review them,
  `kb_document_compose` to write a new one, `kb_document_edit` to revise."*
  Rendered only when the toolset actually includes those tools. The handoff
  builders' rule applies verbatim: the id is injected; the model never
  guesses one.
- **`kb_document_compose` / `kb_draft_write`** into the home space: create as
  today (agent-authored version, FileService bytes, streaming popup). Publish
  semantics in §5.
- **`kb_document_edit`** — unchanged; the base-document read records the
  space scope exactly as it does now (`knowledge-edit.ts:71`).
- **`kb_page_read` / `kb_list` / `kb_search`** — unchanged; the home space
  simply appears among the readable set once the access arm (§4) exists.
  `kb_search` may take `spaceId: <home>` to search only its own notes.
- **`kb_file`** — inside the agent's own space, the agent may reorganize
  *any* page there (its proprietorship), not only its own drafts; elsewhere
  the existing draft-only rule stands.
- **`kb_comments_list` / `kb_comment_*`** — how the agent reads feedback
  humans left on its docs, unchanged.

`agentId` never comes from arguments anywhere in this design — the home
space resolves from the run context, and every other space is reached
through the ordinary viewer gates. An agent can no more touch another
agent's home than it can today: the other space is `private` and the agent
holds no grant (unless a human deliberately added a
`KnowledgeSpaceMember.agentId` row — which remains the sanctioned,
human-only cross-agent sharing mechanism).

## 4. Visibility and permissions — the audience is the agent's audience

### 4.1 Reads: one new arm, delegating to the one predicate

**Product rule:** whoever can see the agent can read its documents. Same
sentence as tables and to-dos, implemented the same way — by composing one
shared agent-visibility predicate, never restating it:

- **Single visibility definition** (`packages/db/src/agent-visibility.ts`):
  `buildVisibleAgentWhere` owns channel-derived reach plus live top-level
  stewardship. `listVisibleAgentIdsForUser` resolves that fragment to ids.
  `listAgentsForUser`, `isAgentVisibleToUser`, KB access, and publication-alert
  revalidation all compose this builder, so the agent page and its documents
  cannot drift. The package is safe to import from knowledge because its Prisma
  client stays lazy and it has no knowledge dependency.
- **TypeScript** (`packages/knowledge/src/access.ts` `loadUserViewer` /
  `canReadSpace`): the asynchronous loader preloads `visibleAgentIds`; the pure,
  synchronous predicate admits an agent-owned space only when that set contains
  `ownerAgentId` or the user holds an explicit `KnowledgeSpaceMember` grant.
  It does not fall through to the ordinary KB visibility switch.
- **SQL mirrors** (`native-search-access.ts` `readableSpaceIdsSqlFor*`): the
  human search path receives the already-resolved visible-agent id array as a
  bound parameter. It never rewrites the channel/steward predicate in SQL.
  The agent search path receives the already-loaded `parentAgentId`, matching
  the pure agent arm. This keeps `kb_search` and human KB search honest without
  a post-filter.
- **Agent-side** (`loadAgentViewer`): the owning agent passes via the
  existing `createdBy === agent.id` grant already; add
  `space.ownerAgentId === agent.id || space.ownerAgentId === agent.parentAgentId`
  so subtask children read and write the parent's home (mirroring tables'
  "owning agent + its spawn_subtask children"). Other agents reach it only
  through an explicit `KnowledgeSpaceMember.agentId` row a human created.

### 4.2 Writes: humans edit like colleagues, structurally bounded

The product brief says humans can *edit* an agent's documents, following the
agent's visibility. Adopted, with the KB's own knobs:

- **Default: write follows read.** Anyone who passes the §4.1 read arm may
  edit (their revisions stamp `authorType: 'user'` — the version history is
  the shared-notebook audit trail). This matches the to-dos stance that an
  agent's working material is deliberately more open than its
  `systemPrompt`, and the same warning ships in the UI copy: these documents
  are visible to everyone who can see the agent — no secrets.
- **The steward can narrow it**: the existing `writeRestricted` flag on the
  space ("public read-only, private write") flips writes to
  explicit-grant-only — meaning the agent (proprietor), its children, and
  explicitly added members. Surfaced as one switch on the Documents tab,
  gated like other agent configuration (org owner in v1; widens to the
  steward when people-and-their-agents phase 3 lands its entitlement
  decision — not pre-empted, same as to-dos).
- **The agent's own writes** are governed by the same `canWriteSpace` it
  passes today as proprietor; nothing new.

### 4.3 Private agents, deactivation, lifecycle

- A **private agent's** docs space is readable by its owner alone — not by
  construction of a parallel rule but because the §4.1 arm delegates to the
  mirror pair, which the agent-scopes work narrows. The `visibility:
  'private'` floor means even a bug in the new arm fails closed.
- **Owner deactivation**: `buildOwnedAgentWhere`'s live-membership
  re-derivation makes a deactivated steward lose sight exactly as they lose
  the agent; the scopes plan's pause-private-agents carve-out needs nothing
  extra here.
- **Agent deletion does not exist** (the honest register in
  people-and-their-agents); the FK is `NoAction` so if deletion ever lands,
  the docs space's fate is a decision that change must take explicitly, not
  a cascade surprise.

## 5. Disclosure — a doc must not widen what the agent consumed

Two directions, both owned by this design:

### 5.1 Reading agent docs feeds the sink (the standing obligation)

`recordKnowledgeSpaceRead` maps spaces through `scopeForVisibility`, and an
agent-owned space breaks that mapping: its stored visibility is `private`
with **no `userId`**, which maps to `null` — silently unscoped, the exact
fail-open defect class AGENTS.md names. So the same change that adds the
access arm extends the basis bridge, beside the reader as always:

- A space with `ownerAgentId` whose agent resolves **private** (once
  `Agent.visibility` lands; until then: never — everything is `workspace`)
  records `{user, <agent.ownerUserId>}` — the doc's audience is one person.
- A space with `ownerAgentId` whose agent is **workspace** records
  **nothing**, on the audience-superset argument the to-dos plan made for
  its checklists: the docs' audience is everyone who can see the agent;
  every destination the agent replies into is a channel it is bound to (or
  presently posting in), whose members can therefore see the agent and so
  the docs. **One verification gate before relying on this:** confirm that
  `send_message` / `message_send` cannot post as the agent into a channel
  whose members would *not* see the agent (an unbound cross-channel post
  would break the superset). If it can, the fallback is to record
  `{user, steward}` conservatively — over-restriction fails closed. Flagged
  in §10, to be settled against code during phase 1, and recorded in the
  basis bridge's comment either way.
- The principled future fix — an `agent:<id>` basis scope type evaluated in
  `viewerSatisfiesBasis` as "viewer passes `isAgentVisibleToUser`" — is
  named but deferred: it extends the basis vocabulary beyond audiences of
  people, which the disclosure design explicitly scoped out, and nothing in
  v1 needs it if the superset argument holds.

### 5.2 Writing agent docs must not launder a privileged read

An agent that consumed a scoped source mid-run and then composes a document
into its home space would otherwise copy restricted material into a wider
audience — the doc itself carries no basis stamp (documents are not
messages). The KB's existing shape already contains the answer; this design
just applies it:

- **Auto-publish only when the run's basis allows it.** Today
  `kb_document_compose` auto-publishes into `private` spaces. For an
  agent-owned space the save gains one structural check: compute the run's
  consumed scopes minus what the *document's audience* implies. If the
  remainder is empty — the common case — the doc publishes immediately, as
  a person watching it stream expects. If it is non-empty, the doc is saved
  as an ordinary **draft** and the agent is told to use
  `kb_publish_request` — the existing human review gate becomes the consent
  mechanism, which is exactly the nod principle: *a human lifts a
  restriction; the agent never does.* For a private agent the audience is
  its steward, so "audience implies" reduces to "does the steward satisfy
  the basis" — evaluable at write time against one person.
- **Close the streaming gap in the same phase.** The document stream lanes
  gain the `runReplyIsRestricted(context)` gate that `stream.delta` and the
  thinking recorder already have, and the session bootstrap route checks the
  run's `runBasisScope` against the viewer — because with agent docs the
  compose volume grows and the pre-existing hole (§1) gets strictly worse.
  This fix is not agent-docs-specific; it repairs `kb_document_compose`
  everywhere, and lands here because this design is what widens the blast
  radius.
- **Edits inherit both rules**: `kb_document_edit` already records the read;
  its save applies the same publish/draft decision to the *new version* it
  creates when the target is an agent-owned space.

## 6. The human interface

### 6.1 The owning surface: a Documents tab on agent detail

A **"Documents" tab joins `AgentDetailTabs`**
(`edit | activity | sub-agents | tools | messages | documents`, alongside
the proposed to-dos and tables tabs) — and per Rule zero check 4 it is **the
existing knowledge workspace component parameterized by space**, exactly as
the project Docs tab already reuses it. Not a new tree, not a new reader,
not a new editor. Behaviour:

- Content resolves through a thin per-agent sub-resource
  (`GET /api/agents/:agentId/docs` → the home space id), gated by the exact
  two-layer pattern the to-dos routes take: `isAgentAccessibleToActor` →
  404 `AGENT_NOT_FOUND`, then the knowledge workspace's own space gates do
  the rest (one predicate chain, §4.1, so tab and tools can never disagree).
  An agent with no home space yet renders an honest empty state, not an
  eager provision.
- Editing uses the KB's existing page editor and file viewer; human edits
  version with `authorType: 'user'`. The `writeRestricted` switch and the
  space's member list (the human-only cross-agent/cross-person sharing
  mechanism, §3) render here for those entitled to manage them.
- The live-compose popup already opens from the channel feed; a document
  being written to the home space is watchable exactly as any KB compose is.

### 6.2 In-context doorways (rule zero, second half)

- The KB workspace itself: an agent-owned space **lists among the viewer's
  spaces** (it passes the same predicate), named "<Agent> — Documents", so
  people find agent notes where they already look for documents; opening it
  deep-links back to the agent.
- The agent's own voice: the prompt block makes "I keep notes on this — see
  my documents" a natural reference, and pasted page links resolve through
  the ordinary KB link handling.
- The existing basis/source affordances name a doc a reply drew on, as they
  do for any KB read.

## 7. Documents vs memory vs to-dos vs tables — the line agents are told

Stated in tool descriptions and the Designer copy, because the four
substrates now coexist:

| Substrate | Written | Grain | Retrieval | Use it for |
|---|---|---|---|---|
| **Memory** (`thoughts`) | by the system, post-hoc | one sentence | implicit recall, top-5, truncated | impressions, preferences, outcomes |
| **Documents** (this design) | by the agent, deliberately | whole versioned artifact | explicit `kb_search`/`kb_page_read` | notes, drafts, reference prose, digests you'll re-read or hand over |
| **To-dos** | Designer or agent-proposed | ordered steps, structural status | injected verbatim | checklists and SOPs *executed* step by step |
| **Tables** | by the agent via typed tools | typed rows | deterministic queries | facts you'll filter, count, join, share |

Memory stays the ambient substrate (no agent tool exists and none is added
here); a document is what the agent writes when it *decides* something is
worth keeping in re-readable form. An SOP's *prose rationale* is a document;
its *executable steps* are a to-do template; the *dataset* behind it is a
table.

## 8. New vs reused

| Need | New | Reused |
|---|---|---|
| The owned home | `KnowledgeSpace.ownerAgentId` (+ index + CHECK), `ensureAgentDocsSpace`, lazy run-setup provision | `KnowledgeSpace`/`KnowledgePage`/`KnowledgePageVersion`/chunks — untouched; `ensureMyDocsSpace` pattern; `metadata` tagging |
| Audience = agent's audience | shared `packages/db` visibility builder + preloaded viewer ids + one read arm in `access.ts` and each SQL/alert mirror | `listAgentsForUser`/`isAgentVisibleToUser` consume the same builder; `visibility:'private'` remains the fail-closed floor |
| Agent authoring | structural prompt block naming the home space; proprietor relaxation of `kb_file` in own space | `kb_document_compose`/`kb_document_edit`/`kb_draft_write`/`kb_file`/`kb_search`/`kb_page_read`/`kb_list`/`kb_comment_*` — no new tool family; the whole streaming stack |
| Human editing | `writeRestricted` + member management surfaced on the tab | KB editor, version history with `authorType`, annotations, `KnowledgeSpaceMember` (users *and* agents) |
| Disclosure | agent-owned-space branch in the basis bridge; basis-aware publish decision on compose/edit saves; `runReplyIsRestricted` gate on document stream + bootstrap | `ConsumedSourceSink`/`computeReplyBasis`/`scopeForVisibility`; `kb_publish_request` + approval effect as the consent gate |
| Human surface | Documents tab entry in `AgentDetailTabs`; `GET /api/agents/:agentId/docs` | knowledge workspace component (parameterized, the project-Docs precedent); `TabBar`; two-layer route gate |

**Deliberately not built:** a second document store or streaming stack, a
`docs_*` tool family, stored audience copies, per-document agent ACLs, an
`agent:` basis scope type (deferred), agent-initiated sharing/widening
(humans manage space membership), a Designer on/off switch (documents are a
base capability like the KB tools already are — a deployment gates via
ordinary tool policy; revisit with tables' identical open question).

## 9. Phased path

Each phase ships with its surface and doc updates in the same turn;
migrations additive only.

1. **The owned space + access + safety.** `ownerAgentId` migration + CHECK;
   `ensureAgentDocsSpace` + lazy provision; the read arm in TS and SQL
   (delegating to the shared DB builder) + the row added to the agent-scopes
   gating table; the basis-bridge branch (with the §5.1 send_message
   verification settled and recorded); the basis-aware publish decision;
   the prompt block. Agents can now keep, re-read, and search their
   documents through the existing tools, and entitled humans already reach
   them through the KB workspace — the capability is human-reachable on day
   one.
2. **The Documents tab.** The per-agent route, the parameterized knowledge
   workspace on agent detail, doorway naming ("<Agent> — Documents"),
   `writeRestricted` + member management placement, no-secrets copy.
3. **Stream restriction gate (implemented 2026-08-31).** `runReplyIsRestricted` on the document
   lanes and the bootstrap route (repairs the pre-existing KB gap
   product-wide). Ordered after 1–2 only because it is independent and
   benefits all composes; teams may land it first. The durable lane remains
   complete for save byte-equality and authorized reconnects; list/detail apply
   the shared run-basis reader before loading target names or chunks, and the
   recorder stamps that run basis before a restricted session becomes
   bootstrap-readable rather than waiting for the final reply.
4. **Refinements with real use:** proprietor ergonomics (`kb_file`
   relaxation if not already in 1), steward-widened template of write
   permissions when people-and-their-agents phase 3 decides entitlements,
   and — if cross-agent doc use grows — the `agent:` basis scope type done
   properly.

Phase 1 is independently shippable and delivers the product sentence by
itself.

## 10. Open questions (flagged, not guessed)

1. **The send_message superset check (§5.1).** Must be verified against
   code before the workspace-agent "record nothing" rule ships; if an agent
   can post into a channel whose members cannot see it, the conservative
   `{user, steward}` stamp is the fallback. *This is the one item that can
   change the design's disclosure posture.*
2. **Write default** — write-follows-read (adopted, per the product brief's
   "humans can edit them too") vs steward-only-by-default with
   `writeRestricted` inverted. Confirm the permissive default is intended
   for shared agents.
3. **Search inclusion** — agent docs appear in org-wide KB search for
   entitled viewers (adopted: discoverability, one predicate). If dozens of
   agents' working notes prove noisy in human search, add a default-off
   facet rather than a visibility change.
4. **Two ownership facts during transition** — `createdBy === agent.id`
   already grants agent access to legacy agent-created spaces;
   `ownerAgentId` is the typed successor. Should a follow-up migration stamp
   `ownerAgentId` onto spaces whose `createdBy` matches an agent id, or does
   the no-fabrication rule apply (a space an agent created for a project is
   not necessarily *its* docs)? Recommended: no backfill; only
   `ensureAgentDocsSpace` writes the column.
5. **Default-on vs gated** — kept default-on (KB tools already are). Tables'
   open question #2 is the same decision; whatever the team picks there
   should apply here identically.
6. **Quota posture** — doc bytes already ride `FileService` accounting and
   `Budget.storageLimitBytes`. Is a per-agent page/space count cap wanted
   (the tables quota instinct), or is org storage quota enough for prose?
   Proposed: org quota only; revisit on abuse.
7. **PA presence runs** (when agent-scopes lands): in a shared channel, a
   PA presence writing "its" notes writes to the *owner's* My Docs — an
   owner-private artifact — which the scopes plan puts behind the
   owner-private tier. Confirm document writes join that tier's
   approval-routed set rather than executing on a stranger's word.
8. **Naming** — "Documents" tab and "<Agent> — Documents" space name;
   "Notes" was considered (warmer, but collides with `kb_note_add`
   annotations). Pick before the tab ships; nothing else depends on it.

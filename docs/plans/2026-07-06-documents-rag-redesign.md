# Documents & RAG Redesign — Knowledge Base v2 + Librarian

**Status:** approved plan (2026-07-06). Supersedes the open items in
[knowledge-base-requirements.md](../knowledge-base-requirements.md) §2.1/§3
(external-source facade, tool contract) — those sections should be read
through this plan from now on.

This plan reviews the current documents ("Knowledge Base") implementation and
redesigns it into: rich hybrid RAG over every document, Obsidian-style linked
notes, first-class private / channel / project / org scoping, ticket-bound
documents inside projects, and a system **Librarian** agent that helps create,
find, and file documents — with review-before-save. Cost discipline is a design
constraint throughout: the ingestion path is deterministic (no LLM), embeddings
use the cheapest viable model, and generative steps are opt-in and gated.

---

## 1. Review — what exists today, and what's missing

### Built and working (keep, don't rewrite)

| Layer | State |
|---|---|
| Authoring | `KnowledgeSpace` → `KnowledgePage` tree → append-only `KnowledgePageVersion`; TipTap WYSIWYG (HTML bodies); draft → published lifecycle; version history/restore |
| Files | `KnowledgePage.kind=file` nodes + drawer attachments, all through the single `FileService` chokepoint with storage accounting; markdown uploads auto-convert to documents |
| Comments/notes | `KnowledgePageAnnotation` — page comments + anchored notes (W3C text-quote selectors), replies, reactions |
| Scoping | Full tenant envelope on space/page/chunk (`organizationId/projectId/teamId/channelId/threadId/userId`), `visibility` (private/channel/team/project/organization), `writeRestricted`, `KnowledgeSpaceMember` grants, `privateToAgentId` |
| Chunking | **Chonkie is already integrated** — `@chonkiejs/core` `RecursiveChunker` (chunkSize 1600, min 240 chars) runs on every version save/restore and writes `KnowledgePageChunk` rows with content, offsets, token counts, and `contentHash` (`packages/knowledge/src/chunking.ts`, `native-chunks.ts`) |
| Index scaffolding | `knowledge_page_chunks` already has `embedding vector(1536)` + HNSW index and a generated `search_vector tsvector` + GIN index |
| Retrieval library | `packages/retrieval` has hybrid candidate generation, RRF fusion (`fuseHybridCandidates`), recall ledger, and a scoped-content SQL access mapping — **currently wired only to `Thought` memories** |
| Embeddings | `@nessie/runtime` inference service exposes `embed()` (OpenAI connector, default `text-embedding-3-small`, 1536 dims) — used by the memory pipeline today |
| RBAC | Two-layer: coarse `checkPolicy` gate per route + fine `canReadSpace`/`canWriteSpace`; explainability envelope (`visibilityReason`, `policyChainTrace`) on every response |

### Gaps (the redesign)

1. **No retrieval over content.** Search is `ILIKE` on title/summary/labels only.
   Page bodies are chunked but never embedded (`embedding` is always NULL) and
   `search_vector` is never queried. There is no RAG.
2. **No agent access to documents.** Agents have KB *comment* tools only —
   they cannot search, read, create, or file pages. No Librarian exists.
3. **Agents bypass privacy.** `SpaceViewer.bypass` skips `canReadSpace` for
   non-human actors. Private docs are not private from agents. Must be closed
   before any agent gets retrieval tools.
4. **No linked-notes layer.** No `[[wikilinks]]`, no backlinks index, no
   unlinked mentions, no graph. Pages relate only via the parent/child tree.
5. **No ticket-bound documents.** `Task` has no relation to `KnowledgePage`;
   `Attachment` has no `taskId`. Project tickets cannot carry docs.
6. **No user-private "My Docs" surface.** The schema supports
   `visibility=private` + `userId` spaces but the admin UI never creates or
   surfaces a personal space.
7. **File nodes are retrieval-invisible.** Only `document` bodies are chunked;
   uploaded PDFs/DOCX/text files are opaque blobs.

---

## 2. Design principles

- **Deterministic-first, generative-last.** Ingestion (extract → chunk →
  embed) uses no completion-model calls. LLM synthesis happens only in
  explicitly requested, bounded paths (`search.summary`, Librarian drafting)
  and is always attributed to the token ledger.
- **One scope envelope everywhere.** The duplicated tenant envelope on
  `KnowledgePageChunk` is the retrieval pre-filter; access is enforced in SQL
  before ranking, never by post-filtering embeddings across tenants.
- **Reuse, don't fork.** Hybrid retrieval generalizes `packages/retrieval`
  (fusion, scoped-content mapping) instead of a parallel KB stack. Embeddings
  go through the existing inference `embed()` capability and record to
  `TokenLedgerEvent`. Files stay behind `FileService`.
- **Cheap by default.** Embedding model is org-configurable, defaulting to the
  cheapest viable tier (`text-embedding-3-small` / `voyage-3.5-lite`, both
  ~$0.02 per 1M tokens; local ONNX model for air-gapped installs). Incremental
  re-embedding by `contentHash` means editing a page re-embeds only changed
  chunks. The Librarian runs on a cheap default model via per-agent
  `provider`/`model` config.
- **Agents obey the same ACLs as humans.** No bypass. An agent sees a private
  doc only when explicitly granted.

---

## 3. Scoping model — private, channel, team, project, org, ticket

The existing `ThoughtVisibility` scoping on spaces is correct and stays. The
redesign completes it:

### 3.1 Personal docs ("My Docs")

- On first visit, auto-provision one personal space per user:
  `visibility=private`, `userId=<user>`, creator-only membership (mirrors the
  existing "General" space seeding).
- Sidebar gets a fixed **My Docs** section above shared spaces.
- Personal spaces are excluded from other users' search and from all agent
  retrieval unless the owner grants the agent access (§3.3).

### 3.2 Channel / team / project / org docs

Already modeled. UI change only: space creation dialog exposes the visibility
picker with plain-language descriptions, and the sidebar groups spaces by
scope (My Docs / this channel / project / organization).

### 3.3 Agent access — close the bypass

- Extend `KnowledgeSpaceMember` with an optional `agentId` (XOR `userId`,
  unique `[spaceId, agentId]`), so spaces can grant access to specific agents
  — this is the "tagged" mechanism: the Librarian (or any agent) has access
  exactly where it has been tagged in.
- Replace `SpaceViewer.bypass` with a real agent principal in
  `packages/knowledge/src/access.ts`:
  - `organization`/`project`/`team`/`channel` visibility → agent must be
    bound (via `AgentBinding`) to a channel inside that scope, or hold an
    explicit `KnowledgeSpaceMember` grant.
  - `private` visibility → explicit `KnowledgeSpaceMember(agentId)` grant or
    `privateToAgentId` match only.
- Retrieval (§4) applies the same rule in SQL via the scoped-content
  membership mapping, so an agent's `kb_search` can never surface chunks from
  spaces it couldn't open.

### 3.4 Ticket-bound documents (projects)

Tickets are `Task` rows. Documents bind to tickets without a parallel storage
system:

- Add `taskId String?` (+ index) to `KnowledgePage` **and**
  `KnowledgePageChunk` (envelope duplication, same as the other scope
  columns). A ticket document is an ordinary page — living in the project's
  space, inheriting its ACL — that carries `taskId`.
- Auto-provision per project a system space **Project Documents**
  (`visibility=project`); ticket docs default into a per-task folder there
  (folder page titled by ticket, `metadata.taskId` set), so the tree stays
  navigable outside the ticket too.
- `TaskDialog` (kanban card) gets a **Documents** tab: list pages where
  `taskId = task.id`, create note, upload file (file nodes with `taskId`).
  Ticket attachments therefore ride the existing `FileService` + KB file-node
  path — no new `Attachment.taskId` column needed.
- Retrieval accepts a `taskId` filter, so "answer from this ticket's docs" is
  a strict SQL pre-filter; agent tools expose the same filter. Deleting a task
  archives (not destroys) its pages.

---

## 4. Rich RAG pipeline

### 4.1 Ingestion (deterministic, no LLM)

```
save/restore version ──► chunk (Chonkie, exists) ──► diff by contentHash
                                                        │ new/changed chunks
                                                        ▼
                                            enqueue knowledge.embed job
                                                        ▼
                                     worker: batch embed → UPDATE embedding
```

- **New queue topic `knowledge.embed`** following the standard recipe:
  Zod payload schema in `packages/schemas/src/jobs.ts`
  (`{ organizationId, pageId, versionId }`), subscribe in
  `worker/src/index.ts`, enqueue from `native-provider.ts` after
  `replaceKnowledgePageVersionChunks`, idempotency key
  `kb-embed:<pageId>:<versionId>`. Retries and locking come free from
  `PgQueueJob`.
- **Incremental embedding.** The handler selects chunks for the page's current
  version where `embedding IS NULL`; before calling the provider it copies
  embeddings from any existing chunk row (any page, same org) with the same
  `contentHash` + same embedding model. Editing one paragraph re-embeds ~1–2
  chunks, not the document.
- **Batching.** Embed up to 64 chunks per provider call (the OpenAI/Voyage
  embeddings APIs accept arrays); one ledger event per call via
  `recordInferenceUsage`, attributed to org/project/space.
- **Embedding provider selection.** Reuse the inference control plane: an
  `InferenceModel` with capability `embedding` per org; default
  `text-embedding-3-small` (1536 dims — matches the existing column and the
  memory pipeline). Self-hosted/air-gapped orgs may register a local
  OpenAI-compatible endpoint (e.g. Ollama `nomic-embed-text`) — dims are
  recorded per chunk (`embeddingModel`, `dims` columns already exist), and a
  model change triggers a lazy re-embed sweep (background job, rate-limited).
- **File-node text extraction (new, still deterministic).** On file-node
  create/version, a `knowledge.extract` job extracts plain text server-side
  for indexable types — `.txt`/`.md`/source code directly, PDF via `pdf-parse`,
  DOCX via `mammoth` — streams capped at a sane extraction limit (default
  20 MB / 500k chars), then feeds the same chunk → embed path with
  `KnowledgePageChunk.pageId` pointing at the file node. Non-extractable types
  (images, archives, binaries) index title + labels only. **No OCR / no
  vision-model calls** in v1 — that is exactly the expensive path we avoid;
  it can become an opt-in per-org toggle later.

### 4.2 Retrieval (hybrid, scope-filtered in SQL)

Generalize `packages/retrieval` from Thought-only to scoped content:

- Add `KNOWLEDGE_CHUNK_SCOPED_CONTENT_MAPPING` next to
  `THOUGHT_SCOPED_CONTENT_MAPPING` (the column-mapping abstraction already
  exists for this) and a `searchKnowledgeChunkCandidates` generator with two
  channels, both scope-pre-filtered:
  - **Lexical:** `search_vector @@ websearch_to_tsquery('english', $q)` ranked
    by `ts_rank_cd` (GIN index already in place).
  - **Semantic:** cosine over `embedding` (HNSW index already in place),
    skipped gracefully when the query embedding or chunk embeddings are
    unavailable — the system degrades to lexical, never to nothing.
- Fuse with the existing `fuseHybridCandidates` RRF (k=60) + recency; group
  chunks by page, return top pages with their best chunks, offsets, and
  scores. Offsets → the reader can highlight the matched passage (same
  anchoring machinery as notes).
- **No reranker model in v1.** RRF over two channels is the proven cheap
  default (this matches the memory-pipeline design decision). A rerank stage
  is a labeled extension point, off by default.
- **Query embedding** is one cheap `embed()` call per search (~trivial cost);
  cache by normalized query text for 15 min to absorb repeated searches.

### 4.3 Search API & UI

- `POST /api/knowledge-base/search` gains `mode: 'keyword' | 'hybrid'`
  (default `hybrid` once embeddings exist; falls back to the current trigram
  search when the org has no embedding model). Existing per-space access
  post-filter is replaced by the SQL scope pre-filter (also fixes the
  O(spaces) scaling concern).
- Results render as page hits with highlighted matched passages and score
  provenance (`lexicalRank`/`semanticRank` surfaced in `visibilityReason`
  style, keeping the explainability contract).
- **`search.summary` (opt-in synthesis).** A bounded endpoint that takes the
  top k (≤ 8) chunks and produces a short cited answer using the org's
  *cheap* completion model, with per-call token cap; every result carries
  page/chunk citations. This is the only generative call in the search path
  and it is user-initiated ("Summarize results"), never automatic.

---

## 5. Obsidian-style notes layer

### 5.1 Wikilinks

- TipTap extension for `[[...]]`: typing `[[` opens a page-title suggestion
  popup (search over the viewer-visible pages, reusing the trigram search);
  selection inserts a `wikilink` node storing `{ pageId, title }`. Renders as
  an internal link; broken links (target deleted/no title match) render in the
  muted "unresolved" style and clicking one offers **Create page** in the
  current space.
- Bodies remain HTML; the wikilink node serializes as
  `<a data-kb-page-id="…">` so `RichTextContent` sanitization keeps working.

### 5.2 Backlinks index

New model, maintained transactionally on version save (same place chunking
runs, so it can never drift from the published body):

```prisma
model KnowledgePageLink {
  id             String   @id @default(cuid())
  organizationId String
  sourcePageId   String   // page containing the link
  targetPageId   String?  // resolved target (null = unresolved)
  targetTitle    String   // raw [[text]] for unresolved links
  createdAt      DateTime @default(now())
  @@unique([sourcePageId, targetPageId, targetTitle])
  @@index([targetPageId])
  @@index([organizationId, targetTitle])
}
```

- Reader sidebar gets a **Backlinks** panel: pages linking here (ACL-filtered
  with the standard space-read check).
- **Unlinked mentions** (pages whose text contains this page's title, via the
  existing trigram index) listed below backlinks with one-click "link it".
- Creating a page whose title matches unresolved `targetTitle` rows resolves
  them (fills `targetPageId`).

### 5.3 Tags and graph

- Tags already exist (`PageLabel`); expose them in the editor as `#tag`
  autocomplete writing through to labels — no new model.
- **Graph view is Phase 5 (explicitly deferred).** The data (links + labels)
  will already be in place; the view is a nice-to-have, not a retrieval
  feature.

---

## 6. The Librarian agent

A system-managed shared agent (`Agent`: `agentKind=shared`,
`systemManaged=true`, name "Librarian"), seeded per organization like other
system agents. Runs on the org's **cheap** completion model by default
(per-agent `provider`/`model`), inside the standard agentic-loop budget
(12 iterations / 20 tool calls / 90 s / cost cap) — the loop, ledger, and
budget gate need no changes.

### 6.1 Access — "everywhere it's tagged"

The Librarian holds no special powers. It sees a space if and only if:
`AgentBinding` puts it in a channel within the space's visibility scope, or a
`KnowledgeSpaceMember(agentId)` grant tags it into the space (including a
user tagging it into their private My Docs). Untagged = invisible, enforced
by §3.3 in both tool access and retrieval SQL.

### 6.2 Tools (new `knowledge-base` builtin family)

Registered via the standard recipe (`BUILTIN_TOOL_DEFINITIONS` +
`executeBuiltinTool` case + auto-seeded `ToolRegistryEntry`, granted via
`ToolGrant`). All take the agent principal through the §3.3 access path.

| Tool | Behavior | `safe` |
|---|---|---|
| `kb_search` | Hybrid retrieval (§4.2); args: query, optional spaceId/taskId/labels, k ≤ 8. Returns compact hits (title, snippet, ids) — never full bodies | yes |
| `kb_page_read` | Full plain-text projection of one page (bounded length) | yes |
| `kb_list` | Tree/space listing for filing decisions | yes |
| `kb_draft_write` | Create a page or a new version — **always `status=draft`**, `authorType=agent`. Cannot publish | no |
| `kb_file` | Move/rename a draft it authored; set labels | no |
| `kb_publish_request` | Requests publication of a draft (§6.3) | no |

The existing `document_read` tool is superseded by `kb_page_read` and retired
with the legacy path.

### 6.3 Review before save

Two reinforcing mechanisms, both already in the platform:

1. **Drafts are the only thing agents can write.** `kb_draft_write` hard-codes
   `draft`; the publish route rejects `authorType=agent` versions publishing
   themselves. A human always flips draft → published in the UI, seeing a
   version diff against the current published version first (version history
   UI already exists; add the diff view).
2. **Approval gate on publish requests.** `kb_publish_request` routes through
   `evaluateToolInvokePolicy` → `ApprovalRequest` (action
   `knowledge.page.publish`, context = pageId + versionId + space). The
   approval surfaces in the existing approvals inbox with a preview link;
   approve publishes and resumes the run via `continuationToken`, reject
   leaves the draft with a comment. Default policy: publish requests to
   `private` spaces auto-route to the space owner; shared spaces to users with
   the `knowledge_page.approve` action (already a seeded policy action).

Librarian drafts appear in the UI with an "agent draft — awaiting review"
badge in the tree and a review queue filter per space.

### 6.4 What the Librarian does (system prompt scope)

Create/structure docs from conversation ("write this up"), file uploads into
the right space/folder, answer "where is / what do we know about X" via
`kb_search` with citations, propose merges of duplicate notes (as drafts +
comments), maintain ticket docs when tagged into a project channel
(`taskId`-scoped drafts). It comments using the existing KB comment tools
rather than editing published pages directly.

---

## 7. Cost controls (explicit)

| Path | Model class | Control |
|---|---|---|
| Chunking, extraction, backlinks | none (deterministic) | n/a |
| Chunk embedding | embedding (~$0.02/1M tok) | incremental by `contentHash`; batch 64; ledger-attributed; org budget (`Budget` mode degrade/enforce) applies |
| Query embedding | embedding | 15-min cache by normalized query |
| `search.summary` | cheap completion | opt-in per call; k ≤ 8 chunks; output token cap |
| Librarian runs | cheap completion (per-agent model) | standard loop budget + org `Budget` gate; interactive-only by default (no scheduled sweeps in v1) |
| Re-embed sweeps (model change) | embedding | background job, rate-limited, resumable |
| OCR / vision extraction | — | **not in v1**; future per-org opt-in |

Worst realistic case: a 100k-word org wiki ≈ 130k tokens ≈ **$0.003** to embed
end-to-end with `text-embedding-3-small`. Embedding cost is a rounding error;
the discipline that matters is keeping completion models out of the automatic
paths, which this design does.

## 8. Data model changes (summary)

- `KnowledgeSpaceMember`: `userId` → optional, add `agentId String?`
  (XOR check in service layer), unique `[spaceId, agentId]`.
- `KnowledgePage`: add `taskId String?` + index.
- `KnowledgePageChunk`: add `taskId String?` + index (envelope duplication).
- New `KnowledgePageLink` (§5.2).
- No changes to `KnowledgePageVersion`, `Attachment`, `Task`, ledger, or queue
  tables. `embedding`/`search_vector` columns and indexes already exist.

## 9. Rollout phases

Each phase is independently shippable and verified (Playwright on 5455) before the
next starts.

1. **Retrieval core** — ✅ **shipped (2026-07-06).** `knowledge.embed` job +
   incremental embedding (copy-by-content-hash, ≤64-chunk batches,
   ledger-billed); hybrid lexical+semantic candidates fused with
   `@nessie/retrieval` RRF (`native-search-hybrid.ts` — kept in
   `packages/knowledge` rather than a retrieval-package mapping, since the
   human-viewer space filter lives naturally beside `canReadSpace`; the
   agent-scope mapping arrives with Phase 2); `mode=hybrid` search API + UI
   passage highlighting in `/search` and the ⌘K palette. *Acceptance
   verified against live pgvector:* body text searchable (lexical-only
   degradation included), private/project spaces never leak across viewers —
   enforced by the in-SQL readable-spaces pre-filter, post-filter removed.
2. **Agent access + Librarian read path** — ✅ **shipped (2026-07-06).**
   `kb_search`/`kb_page_read`/`kb_list` builtin tools
   (`packages/runtime/src/builtin-kb-tools.ts`,
   `worker/src/run/pa-tools/knowledge.ts`), each re-checking the caller's
   `SpaceViewer` (agent-principal ACL, no bypass) before returning results;
   `kb_page_read` additionally denies an agent viewer when the *page itself*
   (not just its space) is `restricted` or privately scoped to a different
   agent. `ensureLibrarianAgent` (`api/src/services/librarian.ts`,
   `POST /api/knowledge-base/librarian`) idempotently seeds the org's shared,
   system-managed Librarian agent and grants it the three read tools plus
   `send_message`; it holds no write tools yet (§6.2's `kb_draft_write`/
   `kb_file`/`kb_publish_request` remain Phase 3). *Note on
   `KnowledgeSpaceMember.agentId` from the original §3.3 plan:* the schema
   already supports agent members (`memberAgentIds` on `KnowledgeSpaceRecord`,
   enforced in `access.ts`'s `canReadSpace`/`canAgentReadSpace`) — this phase
   wires the Librarian and its tools through that existing mechanism rather
   than adding a new column. *Accept:* untagged Librarian returns zero hits
   from a private space; tagged returns cited answers — verified via unit
   tests in `worker/src/run/pa-tools/knowledge.test.ts` and
   `api/test/librarian.test.ts` (live-pgvector acceptance still pending, same
   as noted for Phase 1's initial cut).
3. **Librarian write path** — ✅ **shipped (2026-07-06).** `kb_draft_write`
   (draft-only, active-content guard, embed job enqueued transactionally),
   `kb_file` (agents file only their own drafts), `kb_publish_request`
   (deduped `knowledge.page.publish` ApprovalRequest); the publish endpoint
   403s agent actors; approving runs the effect in
   `api/src/services/approval-effects.ts` with a staleness guard (superseded
   drafts are never published — note recorded instead of resuming the run,
   which proved simpler than continuation tokens for this action). Draft
   review UI: agent-draft badges, line-diff panel, Publish/Request-changes,
   approvals deep link, Needs-review filter. *Acceptance verified live:*
   agents cannot publish; approval publishes exactly the reviewed version.
4. **Notes layer** — ✅ **shipped (2026-07-06).** `[[wikilink]]` TipTap node
   with suggestion popup and create-on-click for unresolved links;
   `knowledge_page_links` maintained transactionally with chunking; creating
   or renaming a page resolves pending links to its title; ACL-filtered
   backlinks + unlinked-mentions endpoints and panel. Deliberately dropped
   from scope: `#tag` autocomplete (labels UI already exists) and the graph
   view (deferred; the link data is in place). *Acceptance verified live:*
   rename keeps id-tracked links; deletes cascade the index.
5. **Tickets + files + extras** — ✅ **shipped (2026-07-06).** `taskId`
   envelope through pages/chunks/search/kb tools; advisory-locked
   Project Documents + per-ticket folder provisioning; TaskDialog Documents
   section (list/note/upload); `knowledge.extract` job (text/PDF/DOCX →
   chunks → embeddings, 20 MiB/500k-char caps, FileService-only byte
   access); `POST /search-summary` (≤8 chunks, one cheap chatJson call,
   validated citations); My Docs auto-provisioning + pinned sidebar section
   and the visibility picker. Graph view remains deferred.

## 10. Security notes

- Embeddings are reconstructable (≈92% of short inputs) — chunk rows inherit
  the page envelope precisely so access control happens before vectors leave
  the database; never expose raw embeddings via API.
- `sensitivityTier=restricted` chunks are excluded from agent retrieval
  entirely in v1 (humans only), making the previously-inert column meaningful.
- All Librarian mutations audit as `kb.*` events with `authorType=agent` +
  the delegating context, same as existing annotation tools.

## 11. Documentation to update alongside implementation

- `docs/knowledge-base-requirements.md` — mark §2.1 external-source models and
  §3 tool contract as superseded by this plan (header pointer added now).
- `docs/functionality.md` — search API + tool family, per phase.
- `docs/the-agents.md` — Librarian entry (Phase 2).
- `CLAUDE.md`/`AGENTS.md` — only if ports/build/workflow change (none
  expected).

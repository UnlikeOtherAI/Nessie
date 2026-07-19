# Knowledge & Memory Fabric — Discovery and Plan

Status: proposed · Date: 2026-05-30 · Author: architecture review (11-agent discovery + synthesis)

## Goal

Give Nessie a **company-wide long-term memory** available to the whole organisation, plus a
**first-party knowledge base** ("Notion/Confluence for the corporation": markdown documents,
hierarchy, search, embeddings), behind a **facade** that can also front third-party knowledge
systems (GitHub, Confluence, Notion, wikis). The first-party store ships first; third-party
sources are mirrored later through the same interface.

This document records where the codebase stands today and the staged plan to get there. It builds
on the existing memory subsystem rather than replacing it, and supersedes the "build it from
scratch" framing in [knowledge-base-requirements.md](../knowledge-base-requirements.md) by treating
that doc's flat `KnowledgeSource → KnowledgeDocument` spec as the **external facade tier**, not the
primary authoring model.

## TL;DR

One **governed retrieval substrate**, **two content lifecycles** riding on it, **one provider
facade**:

1. **Substrate** — extract the existing `Thought` hybrid-retrieval mechanics (pgvector + tsvector +
   RRF fusion + recall ledger) into a shared `packages/retrieval`. pgvector stays; no external
   vector store.
2. **Memory** (system of belief) — finish the `Thought*` subsystem: typed memories, automatic
   formation via post-run consolidation, salience/decay, contradiction handling, outcome-aware
   recall.
3. **Knowledge base** (system of record) — a **new** Confluence-style first-party store:
   hierarchical pages + append-only versions + embeddable chunks, restriction-aware,
   approval-gated.
4. **Facade** (lens over where knowledge already lives) — a `KnowledgeProvider` abstraction modelled
   on the existing MCP `catalog → instance → credential → lifecycle` pattern; the native store is
   the `kind='first_party'` reference provider; GitHub/Confluence/Notion arrive last, read-only by
   default.

Memory and documents are **separate tables** that share the scoping block and the retrieval
substrate, and **link by reference** (provenance), never by merger.

---

## Part 1 — Where we stand (discovery)

Verified against `api/prisma/schema.prisma`, the migrations, and worker code.

### Conversation persistence

- `Message` / `Thread` / `MessageReaction` / `ThreadReadState` are the durable conversation store
  (`schema.prisma:651-730`), scoped org → project → team → channel via `Channel`.
- `ThreadStreamEvent` (`schema.prisma:684-694`) is an **ephemeral** live-replay layer
  (stream.start/delta/reasoning), excluded from reconnect hydration once the final `Message`
  persists (`api/src/realtime/hub.ts:148-159`).
- The agentic loop loads the last ~20 messages (`api/src/services/messages.ts:1116-1134`) and
  recalls memories via `searchAndLogThoughtsInScopes` (`worker/src/run/execute.ts:982`) before
  inference.
- **Gaps**: no full-text/semantic index on `Message.content`; no message edit/version tracking
  (hard delete only); `AgentMailboxMessage` is a separate queue, not in thread history; no message
  recall ledger.

### Memory subsystem — already ~80% built

- `Thought` (`schema.prisma:1905`) carries `embedding vector(1536)` + `searchVector` tsvector + the
  full tenant scoping block (`organizationId` Cascade FK + project/team/channel/thread/userId +
  `ThoughtVisibility` + `SensitivityTier` + `privateToAgentId`).
- HNSW (`m=16, ef_construction=64`) + GIN indices exist; PL/pgSQL
  `match_thoughts_scoped/_lexical/_hybrid` (migration `20260408193000`) and
  `match_thoughts_in_scopes` (`20260529120000`) enforce membership-based access **inside** the
  ranking query, with RRF(k=60) + recency + outcome fusion.
- `ThoughtReasoning` (outcome lifecycle), `ThoughtLink`
  (supersedes/derived_from/contradicts/supports/relates_to), `ThoughtAuditLog`, `ThoughtRecall`
  (recall ledger: `wasInjected`/`wasReferenced`/`userSignal`) all exist.
- `packages/memory` (capture/extract/search/scopes/recalls/lifecycle) is operational.
- **Phase A update**: agent replies are no longer captured wholesale. Completed runs enqueue
  `memory.run.consolidate`, which emits a bounded set of typed episodic/semantic memories. The
  queue payload freezes the authenticated launch org/project/team/user plus the source
  agent/channel/thread/task. Its model calls use a stable named `memory-consolidation` system
  agent/run and operation ID; the PA channel's internal team remains only the memory-storage
  scope. The consumer validates the source locator and rejects legacy or mismatched payloads
  before database-dependent model dispatch instead of guessing identity from message history.
- **Still designed-but-not-built** (per `docs/memory-pipeline-design.md`): `thought_artifacts`
  (artifact-linked reasons / "why does X exist?"), `recall_training_signals`, reranker,
  decay/consolidation scheduling, and contradiction pipeline.

### Search / embeddings infra

- pgvector + HNSW + GIN, embeddings via `ModelClient.embed` (`packages/runtime/src/model.ts:101`),
  cost-tracked through `TokenLedgerEvent` (`operationType='embedding'`).
- **Present first slice**: Inline KB page version bodies are chunked with
  Chonkie (`@chonkiejs/core` `RecursiveChunker`) into
  `knowledge_page_chunks`, including the shared scoping envelope, generated
  `tsvector`, and optional pgvector columns for the embedding slice.
- **Absent**: body-ref/file-backed chunk ingestion, chunk embeddings,
  `match_knowledge_chunks_*`, reranking, document/message semantic search, and
  RRF outside the thoughts SQL.

### Governance — ready to extend

- `kb.*` audit actions are **already reserved** (`docs/audit-trail-spec.md:182-189`); `PolicyAction`
  already has `search/read/link/reindex/summarize/grant/import` (`schema.prisma:222`).
- `PolicyResourceType` stops at `secret` (`schema.prisma:219`) — **no** `knowledge_*` values yet.
- No `KnowledgeSource/Document/Chunk/Page` models, no `/api/knowledge-base/*` routes.
- The MCP connector pattern (`McpCatalogEntry` `schema.prisma:1426` → `McpServerInstance`
  `schema.prisma:1469`, with `credentialRef`/`lifecycleState`/`healthFailureCount`/`lastError`) is
  the verified template for the third-party facade; `mcp-oauth.ts` / `mcp-credentials.ts` handle
  auth and per-principal credential overrides.

### Prior-art docs

`memory-pipeline-design.md`, `memory-reasoning-and-experience.md`, `ob1-memory-concepts-for-nessie.md`,
`knowledge-base-requirements.md`, `conversation-intelligence-platform.md`, plus the `done/`
memory-security/multi-agent-memory specs.

---

## Part 2 — Six perspectives

The discovery fed six opinionated, partly-conflicting design points of view. Summarised:

1. **Notion-for-corporation (native block/page store).** Own the substrate; agents are
   first-class authors. `KnowledgePage` tree + ordered `KnowledgeBlock` (per-block embeddings) +
   `KnowledgePageRevision` + `KnowledgeLink` backlinks. *Disagrees with facade-first* (makes vendors
   the source of truth, kills agent authorship) and with "docs are big thoughts".

2. **Confluence model (governance is the product).** Spaces → page trees → immutable
   `KnowledgePageVersion` chain → `PageRestriction` (narrow-only) → `PageComment` → `PageLabel`.
   Publish approval mandatory for sensitive spaces. *Disagrees with Notion flat docs* (can't express
   restrictions/approval/provenance) and *defers the block editor* as scope creep.

3. **Third-party facade (the strategic asset).** Don't build "a KB"; build a `KnowledgeProvider`
   interface (`list/read/search/write/sync` + capability flags), native store is just one provider.
   Mirror the MCP `catalog → instance → credential → probe` lifecycle; reuse `mcp-oauth`.
   `synced` vs `live` retrieval modes. *Disagrees with native-first* (most orgs won't migrate off
   Confluence/Notion).

4. **Retrieval-first (the leverage is the engine).** Generalise the working `thoughts` engine into
   one `packages/retrieval` serving memory + documents + (later) messages; per-record-type candidate
   generators feed one RRF + recency + rerank fusion. Chunking, fusion, freshness, reranking are the
   real difficulty — don't build a second search stack. pgvector stays.

5. **Memory-first (memory ≠ documents).** Opposite write/read economics: documents are deliberate,
   versioned, human-owned; memories are automatic, decaying, agent-owned. Finish `Thought*`
   (taxonomy, formation, decay, consolidation, contradiction, outcome scoring); KB sits beside it;
   they link via `thought_sources`/`thought_artifacts`, **never** a shared table.

6. **IA & governance (or it becomes an untrustworthy dump).** One `KnowledgeObject` envelope reusing
   `Thought`'s scoping columns; provenance + citation as a hard contract (`sourceRef` +
   `visibilityReason` + `policyChainTrace` on every hit); freshness/staleness lifecycle; dedup at
   ingest; review/approval; `KnowledgeShareGrant` for cross-project; the facade comes **after** the
   governed envelope exists.

The conflicts cluster on three axes: **one table vs two** (memory/docs), **native-first vs
facade-first**, and **new KB search vs reuse the thoughts engine**. The plan resolves each below.

---

## Part 3 — Key decisions

| Decision | Resolution | Rationale |
|---|---|---|
| Memory vs documents: one table or two? | **Two model families** (`Thought*`; `KnowledgePage/Version/Chunk`), sharing the scoping columns + retrieval substrate, linked by reference. | Opposite write/read economics. Overloading `Thought` with `publishState/parentPageId/version/freshness` bloats the hottest table and turns decay into a document-deletion bug. "Refactor before reuse" is satisfied by a shared typed scoping helper + contract test, not a merged table. |
| First-party authoring model | **Confluence-style hierarchical pages + append-only version chain + narrow-only restrictions.** Markdown bodies first; **defer the block editor**. | Nessie's differentiator is governance, not note-taking ergonomics. Page-level restrictions, publish approval (agents can author!), and immutable change-provenance are what a regulated self-hosted buyer pays for. The flat `knowledge-base-requirements.md` spec is kept **only** as the external facade tier. |
| Native store first or facade first? | **Governed envelope + native store first; facade last** (read-only by default) — but architect the native store from day one as `kind='first_party'` behind the `KnowledgeProvider` interface. | Fronting external systems before governance exists is the untrustworthy-dumping-ground failure (syncing without ACL→sensitivity mapping/approval leaks documents the source would deny). The facade is still required because orgs won't migrate — so define the interface early, implement external providers only after restrictions/freshness/citation contracts are enforced. |
| Vector store | **pgvector + Postgres, no external store.** Reuse HNSW(`m=16, ef_construction=64`) + GIN verbatim. | Org-scoping, RBAC membership, sensitivity tiers, audit, and the recall ledger are all relational and transactional; `match_thoughts_scoped` enforces access *in* the ranking query. An external store forks the access model and splits audit/recall from data. |
| One retrieval engine or per-subsystem? | **One shared `packages/retrieval`**; per-record-type SQL candidate generators feed a common RRF + recency + rerank layer. | Building KB search standalone recreates fusion/recall/access logic and yields two divergent stacks. Concentrate effort on chunking/fusion/freshness/reranking. Gate cross-type fusion on matching `embeddingModel` id so a provider change can't silently mix incompatible vectors. |
| Fix memory capture noise? | **Fix early** (Phase A): replace capture-every-reply-over-16-chars with post-run consolidation emitting typed episodic + semantic memories. | The thoughts table is becoming an unsearchable swamp that degrades the shared substrate everyone depends on. Cheap (additive column + a worker job on the existing pgqueue). |
| Memory ↔ KB connection | **By reference only**: a thin `KnowledgeProvenanceLink` (`thoughtId ↔ page/chunk`, `relation=derived_from`) + an approval-gated "promote memory cluster to page" action. | Closes the "why does X exist?" loop against a citable, versioned artifact without conflating lifecycles. Two-sided audit (`ThoughtAuditLog 'promoted'` + `AuditLog kb.page.created`). Add a thin link table rather than widening `ThoughtLink`'s FK semantics. |

---

## Part 4 — Target architecture

Layered as **Substrate → Content lifecycles → Facade → Consumers**.

### Substrate — `packages/retrieval`

Owns the scoped-search WHERE-clause SQL, RRF(k=60) + recency fusion, and the recall-ledger write
path, extracted from the existing thoughts machinery. `packages/memory` delegates to it (no behaviour
change); new content types call it. Per-record-type candidate generators (`match_thoughts_in_scopes`,
new `match_knowledge_chunks_in_scopes`) feed one fusion layer with per-type quotas so one type can't
drown another.

### Content lifecycle A — Memory (`Thought*`, extended)

Keep all existing tables. Additive columns on `thoughts`: `memory_type` (episodic | semantic |
procedural), `memory_category` (intent | reason | constraint | preference | fact), `embeddingModel`,
`dims`, `consolidated_into`. New `thought_artifacts` and `thought_sources` (provenance bridge to
Message/Run/KnowledgePageVersion) and `recall_training_signals` per `memory-pipeline-design.md`.
Post-run consolidation replaces capture-everything; salience/decay/consolidation/contradiction run as
scheduled workers; outcome status feeds recall scoring.

### Content lifecycle B — Knowledge base (new)

- `KnowledgePage` — tree (`parentPageId`), project-anchored, reusing `ThoughtVisibility` /
  `SensitivityTier`.
- `KnowledgePageVersion` — append-only, monotonic `versionNumber`, draft → published head pointer,
  restore-as-new-version, `authorType` user | agent, markdown `body` (+ `bodyRef` for large bodies).
- `KnowledgePageChunk` — the **only** recall-eligible unit; mirrors `Thought`'s vector columns
  exactly (HNSW + GIN cloned from migration `20260408140200`). Only **published-head** chunks that
  pass scope + restriction checks may surface.
- `PageRestriction` (narrow-only, deny-bias), `PageComment` (inline + footer, threaded), `PageLabel`.
- Optional `KnowledgeSpace` container — see open questions.

### Facade — `KnowledgeProvider`

`KnowledgeSource` is a thin install record modelled on `McpServerInstance` (`catalogProviderId →
credentialRef → transportConfig → syncCursor → lifecycleState → health fields → retrievalMode`)
pointing at a `KnowledgeProvider` (`first_party | github | confluence | notion | wiki | url | mcp`).
Capability flags (`canWrite`, `canIncrementalSync`, `supportsNativeSearch`, `supportsServerSideACL`,
…) let it degrade gracefully (fall back to pgvector search, full re-list, etc.).
`retrievalMode='synced'` materialises external docs into chunk rows; `'live'` proxies at query time
for volatile/huge/sensitive sources. The native store is `kind='first_party'` with **no privileged
code path** but is a required day-one deliverable. `KnowledgeProviderCatalog` mirrors
`McpCatalogEntry` (built-ins seeded `organizationId=null`).

### Consumers

Agents call one `knowledge-base` tool family (`search/read/list/summarize`) in the loop beside the
existing memory recall at `execute.ts:982`; humans hit `POST /api/knowledge-base/search` over the
identical pipeline. Every hit carries non-nullable `sourceRef` + `visibilityReason` +
`policyChainTrace`. Bounded `search.summary` is the **only** synthesis path — no automatic full-doc
injection (per `knowledge-base-requirements.md`).

---

## Part 5 — Phased plan

Dependencies in parentheses. Phases A and B can run in parallel once Phase 0 lands.

### Phase 0 — Shared retrieval substrate *(no new behaviour)*
**Goal:** make the Thought retrieval mechanics reusable by a second content type without forking
access logic.
- Create `packages/retrieval` housing the RRF(k=60) + recency fusion (currently inline in
  `match_thoughts_hybrid`, migration `20260408193000`) and the scoped-membership WHERE-clause
  pattern.
- Refactor `packages/memory/src/search.ts` to delegate fusion + recall-write to `packages/retrieval`
  with **zero behaviour change** (regression-tested).
- Additive migration: `embeddingModel` + `dims` on `thoughts`; backfill with current provider/model.
- Extract the scoping column set + access predicate into a typed helper + a **contract test**
  asserting any new content table exposes identical scoping semantics.

### Phase A — Memory hygiene + taxonomy *(Phase 0; parallel track)*
**Goal:** stop polluting the shared index; make memory typed and outcome-aware.
- Additive migration: `memory_type`, `memory_category` (existing rows default to `semantic`/`fact`).
- Replace per-response capture with a **post-run consolidation** job on the existing pgqueue that
  reads Run/Task + thread tail and emits typed episodic + semantic memories.
- Wire `ThoughtReasoning.outcome` into recall scoring (SUCCESSFUL > PARTIALLY > PENDING > FAILED) via
  the shared fusion constants and matching SQL formula.
- Enforce the **audience-compatibility** recall check (`Audience(current) ⊆ Audience(source)`) in
  `match_thoughts_scoped` and `match_thoughts_in_scopes` — close the documented cross-channel leakage
  gap **before** adding document volume. Deny-bias test suite.

### Phase B — Governed first-party KB envelope *(Phase 0)*
**Goal:** a Confluence-grade governed document store — governance and provenance first, no third-party
content, no embeddings yet.
- Prisma models + migration: `KnowledgePage` (tree), append-only `KnowledgePageVersion`, `PageLabel`
  (and `KnowledgeSpace` if adopted).
- Add `knowledge_space` / `knowledge_page` to `PolicyResourceType` (the reserved Phase-3 slot,
  `schema.prisma:219`); gate every route with the existing `requirePolicy` deny-overrides chain
  (actions already in `PolicyAction`).
- Wire `kb.*` `AuditLog` emission (names reserved in `audit-trail-spec.md:182-189`) on
  create/edit/publish/move.
- REST `/api/knowledge-base/*` (spaces, pages, versions) with **deterministic** metadata/title/label
  search, keyset pagination (`(updatedAt, id)`), returning `visibilityReason` + `policyChainTrace` +
  `sourceRef`. Archived pages remain readable by direct id but are immutable; publish/edit/move/restore
  return conflict, page-version `authorType` is derived from the authenticated actor, and space page
  listing first proves the space belongs to the caller's organization.
- Define the `KnowledgeProvider` TypeScript interface + capability flags in `packages/knowledge`;
  native store as the first reference provider.
- Admin `features/knowledge` surface: page tree + version-diff viewer (React 19 + Tailwind v4 +
  react-query); kelpie-verify at `localhost:5555`.

### Phase C — KB access governance + semantic recall *(Phase B)*
**Goal:** make the KB restriction-aware, approval-gated, and semantically searchable through the
shared substrate; only published-head chunks recall-eligible.
- `PageRestriction` (narrow-only) evaluated inside the existing `PolicyRule` chain (restriction
  subtraction); deny-bias test suite **before** any page is recall-eligible.
- `ApprovalRequest` gating (`action='kb.page.publish'`) for sensitive/restricted spaces — mandatory
  because agents can author; the new version becomes the recall-visible head only once approved.
- `KnowledgePageChunk` model (`vector(1536)` + tsvector, HNSW + GIN cloned from `20260408140200`);
  idempotent publish → chunk → embed worker job keyed on `versionId`, on the pgqueue, cost-tracked
  via `TokenLedgerEvent operationType='embedding'`.
- `match_knowledge_chunks_scoped/_in_scopes` cloned from `match_thoughts_*`; register chunks as a
  candidate generator in `packages/retrieval` (per-type quotas).
- `KnowledgeShareGrant` (`sourceId + targetProjectId + actions + expiresAt`) for cross-project read.
- `PageComment` (inline + footer, threaded, resolve).

### Phase D — Unified `retrieve()` in the loop + memory↔KB bridge *(Phase A + Phase C)*
**Goal:** agents recall memory AND documents in one ranked context block; "why does X exist?"
resolves to a citable page version.
- Single `retrieve()` entrypoint wired beside the memory recall at `execute.ts:982`, merged into one
  `buildMemoryContext`, under the run's existing iteration/token/cost caps (**measured** against the
  budget engine, not assumed free).
- `KnowledgeRecall` ledger cloned from `ThoughtRecall` (same `wasInjected/wasReferenced/userSignal`
  signals feed the same future reranker).
- `KnowledgeProvenanceLink` (`thoughtId ↔ version/chunk`, `relation=derived_from`): worker extraction
  links derived Thoughts to the source page version.
- Approval-gated "**promote memory cluster to KnowledgePage**" action (declassification event);
  two-sided audit.
- `knowledge-base` agent tool family (`search/read/list/summarize`) dispatched through the existing
  `tool-dispatch`/`tool-policy` path; bounded `search.summary` only.

### Phase E — Memory cognition *(Phase A + Phase D)*
**Goal:** turn the memory store into long-term cognition rather than an append log, safely.
- Scheduled worker (pgqueue): recency decay of effective importance; near-duplicate episodic
  consolidation into semantic memories with `derived_from` links; soft-delete archival of
  low-salience never-recalled episodics — **exempting** `memory_category=reason` and
  `outcome=successful`, and only ever soft-deleting.
- Contradiction detection on capture: high-similarity conflicting assertions create a `contradicts`
  `ThoughtLink` routed to the existing supersedes flow; restricted/sensitive contradictions go to
  `ApprovalRequest`.
- Batch-aggregate `thought_recalls` + `KnowledgeRecall` into `recall_training_signals` for a future
  reranker.

### Phase F — Third-party facade *(Phase D)*
**Goal:** bring GitHub/Confluence/Notion/wikis into the same retrieval/governance/citation surface
without making external vendors the source of truth. Read-only by default.
- `KnowledgeProviderCatalog` (analogue of `McpCatalogEntry`, built-ins seeded `organizationId=null`)
  + extend `KnowledgeSource` to the `McpServerInstance` shape (`catalogProviderId`, `credentialRef`,
  `transportConfig`, `syncCursor`, `lifecycleState`, `healthFailureCount`, `lastError`,
  `retrievalMode synced|live`).
- Reuse `api/src/services/mcp-oauth.ts` (SecretStore, OAuth) and `mcp-credentials.ts`
  (`resolveCredentialRef`, per-principal overrides) verbatim; register provider routes as a sibling
  shim to `registerMcpRoutes`.
- `kb.sync.source` worker job mirroring `mcp-instances.ts` probe/refresh/healthcheck; incremental
  sync via `syncCursor`; checksum-gated re-embedding; **conservative ACL→sensitivityTier mapping
  defaulting to restricted**, broadening only via explicit curator approval (`supportsServerSideACL`).
- Per-provider markdown normalization adapters (Confluence XHTML, Notion blocks, GitHub markdown)
  with golden-file tests; store `rawBodyRef` for re-normalization. Prefer existing remote MCP servers
  (Atlassian/Confluence, GitHub) over bespoke clients — for `mcp`-kind sources delegate to
  `@nessie/mcp-client`.
- `retrievalMode='live'` passthrough for volatile/huge/sensitive sources; synced sources land as
  chunks in the same index so retrieval stays source-agnostic; `freshnessState`
  (fresh|stale|orphaned|removed) gates and downweights retrieval and renders `syncedAt` in citations.
- Optimistic-concurrency write-through (`If-Match` on `remoteVersion`, 409 on mismatch); write
  capability **off by default** (GitHub writes via PR).
- Connector order: **Confluence (via Atlassian MCP) → GitHub → Notion**.

---

## Part 6 — Reuse vs new

**Reuse (verbatim or by delegation):** pgvector + HNSW + GIN from migrations
`20260408140000`/`140200`; the `match_thoughts_*` membership WHERE-clauses (clone into
`match_knowledge_chunks_*`); RRF(k=60) + recency fusion from `20260408193000` (extract into
`packages/retrieval`); the `ModelClient.embed → InferenceService` path with `TokenLedgerEvent`
embedding cost tracking; the Thought scoping columns as a shared typed helper; the
`PolicyRule`/`PolicyBinding` deny-overrides chain with `requirePolicy` (only add `knowledge_*` to
`PolicyResourceType` — actions already exist); the immutable `AuditLog` with reserved `kb.*` actions;
`ApprovalRequest` for `kb.page.publish` / `kb.share` / promote; the pgqueue for embed/sync/consolidation
jobs; the `McpCatalogEntry → McpServerInstance` lifecycle + `mcp-oauth.ts`/`mcp-credentials.ts` for the
facade; the `ThoughtRecall` ledger pattern (clone for `KnowledgeRecall`).

**Extend (additive migrations):** `thoughts` gains `memory_type`, `memory_category`,
`embeddingModel`, `dims`, `consolidated_into`.

**Build new:** `packages/retrieval` (shared fusion/scoped-search/ledger); `packages/knowledge`
(`KnowledgeProvider` interface + capability flags + native provider + normalization adapters);
`KnowledgePage`/`KnowledgePageVersion`/`KnowledgePageChunk`/`PageRestriction`/`PageComment`/`PageLabel`;
`KnowledgeProviderCatalog` + `McpServerInstance`-shaped `KnowledgeSource` + `KnowledgeShareGrant`;
`KnowledgeRecall`; `KnowledgeProvenanceLink`; `/api/knowledge-base/*` routes; the `knowledge-base` agent
tool family; the admin `features/knowledge` surface; the post-run consolidation + decay/consolidation/
contradiction workers.

The flat `KnowledgeSource → KnowledgeDocument` spec in `knowledge-base-requirements.md` is reused as
the **external facade tier**, not the first-party authoring model.

---

## Part 7 — Open questions

- **Chunking strategy** for versioned pages and synced docs: the first
  implementation uses Chonkie recursive chunking over the canonical plain-text
  page projection and persists offsets/content hashes. Chunk quality still needs
  a golden-file evaluation harness before semantic retrieval is trusted.
- **Per-type quotas vs pure RRF** when fusing memory + document + (later) message candidates: does
  one type drown another, and at what corpus ratio? Measure once both candidate generators exist.
- **Reranker timing and cost**: an LLM-scoring or cross-encoder rerank per run consumes the agentic
  loop's caps (12 iters / 20 calls / 90 s / cost). Measure against the budget engine before enabling
  in the loop.
- **Does `KnowledgeSpace` add value** over reusing `KnowledgeSource(kind='first_party')` as the
  native container? Decide whether the project boundary + a native source is sufficient.
- **ACL→sensitivity mapping fidelity** for Confluence/Notion: how conservative is "default
  restricted", and what is the exact curator-approval UX to broaden? Top facade leak risk.
- **Embedding model migration policy**: a provider/model change re-costs both corpora; the
  `embeddingModel`/`dims` columns gate fusion, but the re-embed backfill job needs a defined trigger
  and budget.
- **Message semantic search** (the `Message.content` gap) is deliberately deferred — confirm it stays
  out of the initial north-star scope rather than being folded into the unified index early.
- **Embedding-at-rest sensitivity**: vectors are not safe at rest in a multi-tenant store; promoting
  sensitive memories into KB chunks widens the surface — does this need encryption-at-rest +
  rate-limited search before restricted-tier content is embedded?

---

## Part 8 — Risks

- **Schema/access drift** between `thoughts` and `KnowledgeChunk`: two hand-maintained scoping blocks
  could fork access predicates — a tenancy breach. Mitigate with the shared typed helper + contract
  test from Phase 0 and one cloned SQL membership clause.
- **Restriction widening bug**: `PageRestriction` must only ever narrow inherited scope; a widening
  bug is a tenancy breach. Restriction-subtraction inside the evaluated `PolicyRule` chain + deny-bias
  test suite before any page is recall-eligible.
- **Recall leakage** of draft/restricted/unpublished chunks into agent context: only published-head
  chunks passing the full scope + restriction check may surface. Highest-severity correctness risk in
  the KB track.
- **Capture noise compounding** into the shared index: if Phase A lags the document work, the thoughts
  table becomes an unsearchable swamp that drags down unified retrieval. Sequence Phase A before
  adding document volume.
- **Decay deleting load-bearing memory**: a rarely-recalled reason ("why the phone field exists") is
  exactly the high-value low-frequency case naive decay would archive. Exempt `memory_category=reason`
  and `outcome=successful`; soft-delete only.
- **Agent-authored hallucinated canonical knowledge**: without approval-on-publish for
  sensitive/restricted spaces, an agent could publish fabricated system-of-record content. Approval
  gating is mandatory.
- **Third-party ACL impedance mismatch**: synced pages may become visible to people the source would
  deny. Conservative ACL→sensitivity mapping (default restricted), explicit curator approval to
  broaden, `supportsServerSideACL` gating — and put the facade after governance (Phase F).
- **Stale third-party content presented as authoritative**: `freshnessState` must actually
  gate/downweight retrieval and render `syncedAt` in citations, not merely decorate the UI.
- **Embedding-space coupling**: forcing thoughts and chunks into one 1536-dim space means a
  provider/model change re-costs both corpora; gate cross-type fusion on matching `embeddingModel` id.
- **Loop cost/latency**: chunk recall + rerank per run consumes the loop caps; measure against the
  budget engine and cap the rerank candidate set.
- **Scope creep into full RAG or a heavy block editor**: requirements deliberately choose
  deterministic-metadata-first + bounded `search.summary`, and the editor is a deep well. Hold the
  line — markdown versioned pages first, semantic recall as augmentation, no auto full-doc injection.
- **pgvector migration discipline**: Prisma cannot manage HNSW/GIN indices on `Unsupported` columns;
  the index DDL must be hand-written in the migration (copied exactly from `20260408140200`) or the
  indices silently won't be created.

---

## Related docs

- [knowledge-base-requirements.md](../knowledge-base-requirements.md) — Phase-3 KB spec (now the
  external facade tier)
- [memory-pipeline-design.md](../memory-pipeline-design.md) — capture/assignment/storage/retrieval
  stages
- [memory-reasoning-and-experience.md](../memory-reasoning-and-experience.md) — reasoning + outcome
  experience
- [conversation-intelligence-platform.md](../conversation-intelligence-platform.md) — scope resolution
- [audit-trail-spec.md](../audit-trail-spec.md) — reserved `kb.*` audit actions
- [implementation-phases.md](../implementation-phases.md) — Phase 2 (current) vs Phase 3

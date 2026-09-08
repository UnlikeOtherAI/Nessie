# Agent documents, conversation recall and learning from work

Status: implementation in progress, 2026-09-08. Product direction requested by
Ondrej. Canonical Markdown storage and editing have landed in Nessie. The shared
learning helpers and procedure-artifact guards have landed in deep.agent.
Document disclosure, core instructions, conversation recall and automatic
learning remain in progress. This document covers both repositories.

### Implementation record

- [deep.agent PR #2](https://github.com/UnlikeOtherAI/deep.agent/pull/2) merged
  at `26b8cf9edc9fe12947eedf070762f0f19d48f7d7`: stateless evidence-grounded
  distillation and separate verification, complete-record context selection,
  input budgets and source/version validation. Local lint, build and workspace
  tests passed. Nessie has not adopted these new exports yet; this is the
  shared-library portion of Phase 4, not an enabled learning loop or a measured
  improvement result.
- [deep.agent PR #3](https://github.com/UnlikeOtherAI/deep.agent/pull/3) merged
  at `1fd3d43406eac02632f1f8a452896e865f4a5fb1`: required scanning of authored
  instructions and instruction references, explicit data/citation roles,
  immutable artifact validation and bounded nested materialization. Local lint,
  build and workspace tests passed; the agent package's 143 tests also passed
  during independent review. Nessie has not yet adopted procedure activation.
- [Nessie PR #424](https://github.com/UnlikeOtherAI/Nessie/pull/424) merged
  at `ed3f8d6dea9e69af292ecb87f197453fd0a5cb36`: canonical FileService Markdown,
  hash-bound HTML/chunk projections, resumable repair, model-aware indexing and
  version-fenced editing. All nine CI jobs passed. Authenticated headless
  Playwright verified upload/edit/download byte and hash equality, extensionless
  rename/reopen, and concurrent editors retaining the stale draft while
  preserving the newer version. This is the Markdown portion of Phase 1;
  document disclosure and live UOA entitlement changes are separate foundations.
  Existing destination containment remains in place.

## Outcome and product decisions

An agent has an inspectable, editable body of Markdown documents that shapes
how it speaks and works, remembers useful experience, and holds its examples,
templates and procedures. A person finds these in the agent's **Documents** tab.
The agent can recover relevant earlier conversations with people and other
agents, learn from corrections and verified results, and improve its documents
without asking people to record a routine first. Existing checklists stay.

The durable improvement is a change to these external documents and procedures,
not to model weights. Embeddings make eligible content discoverable; they do not
establish truth, confer access, or guarantee that a lesson improved a result.

- **One document home, distinct roles.** Identity, working rules, facts,
  templates, examples, procedures and experiences are ordinary versioned
  Knowledge documents. No second notebook app or hidden agent-memory file tree.
- **Small core, selective recall.** Load authorized core instructions on every
  run. Search and progressively read the remaining documents and raw history.
- **Learning follows ordinary work.** Explicit teaching and a successful example
  can produce a reusable procedure. Repetition is evidence, not a prerequisite.
- **No Record routine button or mandatory recording mode.** Retire the capture
  UX and its unused machinery after migrating its retained artifacts. Keep the
  Workflows engine, existing installations and To-dos/checklist lifecycle.
- **Evidence survives distillation.** Every learned document revision links to
  its source messages, document versions, runs and observed outcomes.
- **Visibility is not edit authority or disclosure permission.** Seeing an agent
  must not let somebody overwrite its core instructions or read another person's
  conversations. A lesson never loses its source restrictions by being reworded.

## Research adopted, adapted and excluded

The user-supplied Hermes/OpenAI comparison informs these design decisions. Its
vendor implementation and pricing/lifecycle claims are not independently
verified here, and are not dependencies of this plan.

| Research pattern | Nessie decision |
| --- | --- |
| Separate persona, semantic knowledge, episodes and procedures | Typed document roles plus the existing conversation store; one visible Documents surface |
| Small always-present persona/memory files | Bounded core instruction documents loaded by role, not by a magic filename |
| Raw episodes behind distilled memories | Preserve canonical Message/Run evidence and exact source-version links |
| Progressive skill/document loading | Search descriptors and passages, then load relevant document sections with source IDs |
| Background reflection | Metered, durable learning jobs proposing evidence-grounded document revisions |
| Human-readable memory and reversible edits | Markdown source, version history, visible diffs and existing review controls |
| Hybrid retrieval and metadata filters | Extend Nessie's PostgreSQL/pgvector and shared retrieval package |
| Evaluate before and after learning | Paired task evals, correction tests, privacy gates and rollback by version |
| Local USER.md profile or another hosted memory authority | Do not copy UOA profiles or introduce a second Nessie memory authority |
| Provider-specific fine-tuning or opaque compaction as memory | Out of scope; retain model independence and auditable source records |

Reference anchors: [Hermes memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory),
[Codex memory](https://learn.chatgpt.com/docs/customization/memories),
[Retrieval](https://developers.openai.com/api/docs/guides/retrieval),
[Reflexion](https://arxiv.org/abs/2303.11366). These are research references,
not a proposal to adopt those services or copy their undocumented internals.

## Current implementation and concrete gaps

Nessie baseline: 86a912f5a. deep.agent inspected checkout: c0aa069c4;
Nessie's installed dependency is separately commit-pinned. Revalidate changed
seams before implementation rather than assuming either checkout is deployed.

| Area | Current code | Required change |
| --- | --- | --- |
| Documents home | knowledge/provisioning.ts; AgentDocumentsTab reuses KnowledgeWorkspace | Keep the home; add document roles and learning provenance |
| Markdown | compose saves an attachment; file versions have null body; kb_page_read reads body | One canonical Markdown read/write/index contract through FileService |
| Document search | Body chunks and hybrid search exist | Cover authored files, revisions, backfill, embedding model compatibility and deletion |
| Chat recall | Last 20 turns; conversation search is lexical; memory injects five 220-character snippets without reasoning | Hybrid source-backed history plus token-budgeted context assembly |
| Memory capture | Per-user message copies and completed-run consolidation into Thoughts | Stop duplicate transcript capture; migrate durable agent knowledge into documents |
| Distillation | English regex sentence selection in memory/consolidate.ts | Model-judged extraction, qualification and contradiction decisions |
| Feedback | Outcome API affects SQL ranking; signal API has no complete consumption loop | Connect actual corrections, acceptance and failures to document evidence and evals |
| Privacy | Run/message provenance exists; draft-write guard and document version lineage are incomplete | Enforce the same source boundary at every document writer and reader |
| Shared core | Nessie imports deep.agent compaction only | Add independently usable learning/context helpers; retain Nessie's runner |

deep.agent has real prompt fencing, provenance gates and immutable skill
artifact helpers, but its current createAgent path does not implement the full
automatic extraction/curation loop described in its self-improving guide. Its
MemoryStore/classification tuple cannot express Nessie's full disclosure basis.
Do not adopt that store as an ACL substitute or dual-write to remember.ninja.

## 1. Documents as the durable agent knowledge

Use KnowledgeSpace, KnowledgePage, KnowledgePageVersion, attachments and chunks.
Markdown attachment bytes are the canonical source for Markdown file documents;
the readable/indexed body is a derived projection tied to that exact version and
content hash. A file update cannot independently edit those two representations.
Rich-text and other file types retain their existing formats and ingestion.

| Role | Example name, editable by the person | Use in a run |
| --- | --- | --- |
| Identity | Identity.md | Role, attitude, voice; core instruction snapshot |
| Working rules | Working style.md | Durable working preferences and explicit constraints; core snapshot |
| Knowledge | Product decisions.md | Distilled scoped claims, reasons and qualifications; retrieved |
| Template | Templates/Follow-up email.md | Reusable structure, variables and tone; retrieved |
| Example | Examples/Accepted proposal.md | Evidence-backed worked output with context; retrieved |
| Procedure | Procedures/Handle a refund.md | Inputs, ordered guidance, decisions and expected result; retrieved |
| Experience | Experiences/Delivery delays.md | What happened, what worked/failed, why and applicability; retrieved |

Roles are validated service metadata, never inferred from names or document
contents. Renaming a file cannot grant instruction authority. Create the small
core from existing authorized configuration; create other documents only when
there is useful content, not empty folder trees or placeholder experiences.

Extend the existing version model with typed role/trust/origin and source
relationships. Store evidence status (observed, explicitly confirmed, inferred
or unverified import), applicability, verification time and supersession links.
Metadata supports the Markdown; it is not a second editable copy of the claim.
Use stable section anchors for specific claims where necessary, not a separate
free-standing fact registry. Start with document-version disclosure granularity;
split differently scoped material into separate documents instead of inventing
invisible per-paragraph permissions.

Keep ordinary agents' existing homes and child-to-parent home relationship.
For a Personal Assistant or other per-person system-agent interaction, place
personal documents in that person's My Docs and show that scoped view through
the same document components. Never give an org-singleton blueprint one shared
personal notebook. System-managed base instructions remain immutable; personal
preferences are a separately authorized overlay. Provision/open these homes
through existing services, not tool-name completeness as a prerequisite for a
human to author instructions. Script-only/external execution paths must explicitly
declare whether this context applies rather than implying a model uses it.

Personal system-agent overlays use the current delegated person's subject and
My Docs edit authority, not canEditAgent on the immutable org-singleton. An agent
may propose changes only within that person's existing delegation. No overlay
may modify the blueprint, another person's preferences, or runtime permissions.

### One place to edit instructions

Migrate configurable agent systemPrompt content to authorized core Markdown
versions. Designer and chat agent_update must read/write those same versions;
they must not retain a second writable systemPrompt. Preserve an exact migration
mapping and source version. Model/tool/budget configuration remains structured.
Generic KB edits, uploads, restores, role changes and chat tools must all enforce
canEditAgent/assertAgentFieldAuthority for core documents. Existing broad notebook
write access is not sufficient. Version restoration is a new authorized revision.

Bind active core and procedure instructions to an explicit approved/published
revision. Pending proposals and a latest-but-unapproved draft must never enter
active instruction loading or routine recall. Editors may inspect those drafts
through the existing review surface with their status visible. Reuse version
publication semantics deliberately rather than the current latest-version search
selection as an accidental activation policy.

Explicit user-authored core text is not silently rewritten by reflection.
Agent-authored experiences and templates may improve automatically under the
learning policy below. An authorized explicit request such as "make your voice
concise" applies directly through the same edit service and returns the changed
revision; no extra approval is required. Autonomous or ambiguous changes to core
personality/working instructions appear as an exact proposed diff for the
authorized editor. Do not add a second confirmation for an already authorized edit.

## 2. Recall, embeddings and context assembly

Index all eligible document bodies and conversational text, including agent
messages, across authorized conversations. Each index entry references canonical
source ID, version/hash, agent participation, tenant and disclosure provenance.
Use natural message/reply boundaries and bounded multi-message windows for
conversation passages; retain neighboring turns for exact-context expansion.
Do not embed raw credentials, hidden system instructions, discarded/deleted
content or indiscriminate full tool arguments. Embeddings inherit source access.

Extend packages/retrieval candidate generation and fusion. Reuse the existing
knowledge chunker/embedding queue for documents and add a conversation projection
over Message records, not a duplicate transcript table. Query rewriting and
relevance/contradiction judgments use the model, including Czech, slang and
misspellings. Exact identifier matching and structural filters remain lexical.
Check embedding model identity as well as EMBEDDING_DIMENSIONS before comparing
vectors; use the configured embedding client and Ledger attribution everywhere.

Context assembly has four parts: runtime policy, authorized core documents,
the current conversation/checkpoint, and retrieved passages/procedure descriptors.
Core instructions are loaded deterministically, never dependent on semantic
similarity. Other documents remain contextual evidence until selected for the
task; a retrieved quote cannot become a new runtime policy or tool permission.
Apply the existing instruction precedence: runtime/security policy is immutable,
authorized agent defaults guide behavior, and the latest permitted user request
can specialize style and task choices. Learned material cannot override explicit
instructions or capability boundaries.

Start with configurable ceilings of 2,000 tokens for core documents and 4,000
tokens for retrieved content, bounded further by the real model context/run
budget and measured before inference. These are initial tuning values, not
storage limits. Do not silently truncate mandatory core instructions: surface
an actionable oversized-core state and require an authorized edit. Preserve
reasoning, exceptions and source links in retrieval instead of arbitrary
220-character cuts. Full documents/episodes remain available through paginated
read/search tools under the same budget. Diverse-source quotas avoid one long
conversation crowding out every procedure.

Take a versioned core snapshot at run admission for reproducibility and caching.
A new run sees the latest committed core; explicit same-run edits return the
saved revision for immediate use as authorized context. Always recheck access
and tombstones before further source/tool use. Compaction keeps source IDs and
the accumulated disclosure basis; it never becomes a source of permanent facts.

### Consistency and failure states

A committed Markdown save is immediately readable by ID through FileService.
Its indexed revision is explicit: saved, indexing, searchable, or failed with a
remedy. Enqueue indexing transactionally; use idempotency on source/version/model,
and discard late jobs for stale revisions. Retry transient failures with bounded
backoff. Latest text search/direct reads must remain honest about semantic-index
lag; do not silently serve an old vector as current text. Re-embedding uses a
versioned generation and switches query/index model together after coverage checks.

Deletion/revocation excludes content before candidate text, titles or snippets
leave storage, even if vector cleanup is pending. Invalidate derived lessons,
caches and checkpoints according to their evidence dependencies. Recheck at
load and materialization, not just enqueue or search. Use existing capability
health transitions and source document status to expose indexing failure; no
new operational dashboard on a member-facing surface.

## 3. Conversation privacy and authority

An agent can search its currently authorized conversations with different people
and agents. Participation/bindings help select candidates; historical
participation is not an irrevocable access grant. Shared-agent recall need not
stay silently confined to its current channel once the end-to-end disclosure
gates below are complete. Person-delegating system agents continue to act within
the effective person's rights. Do not switch the existing containment floor off
globally as an implementation shortcut.

Separate what the agent may consume from who may read the result. Every recalled
passage, expanded source and learned revision carries the full conjunction of
source scopes and original private-conversation authors into ConsumedSourceSink.
Enforce that basis on replies, document lists/titles/bodies/search, previews,
downloads, versions, comments, run metadata, streams and every export-capable tool.
Unrelated tools must not receive private source text through their arguments.
Gate arbitrary write/egress capability after private consumption unless its
destination can enforce that exact basis; prompt instructions are insufficient.

An agent home may contain both generally readable and restricted documents.
For each reader, access is the intersection of home entitlement and the document
version's source basis; restricted titles do not appear in lists or counts.
This extends the shared document authorization service, not a bespoke agent-tab
filter. Store one document under its true scope; never create a public shadow.

An example: Alice's private negotiation informs a lesson accessible in Alice's
authorized context. Bob cannot retrieve that lesson or its title just because
he can see the agent. Turning it into a shared template requires an exact-content
disclosure grant from the original author(s). Extend the existing grant service
deliberately to bind a document version/hash and destination; a message grant
does not authorize document publication. Keep multi-author promotion unavailable
until every source author can authorize that same version through a completed
collective grant path. Missing or legacy lineage remains fail-closed.
Removing names or calling it a generic pattern does not declassify it. A
separately supplied public example can support an independently derived lesson.

Memory scope resolution currently depends on local org/team membership tables,
which conflicts with UOA's sole-authority rule. The expanded retrieval boundary
must consume fresh API-backed UOA entitlement resolution with a bounded cache,
while preserving Nessie-owned project/channel grants and stable subjects.
Coordinate the authority refactor and data migration with the existing
UOA-as-a-service plan; do not create another membership/profile store. Raw source
content may mention people, but documents must not become an authoritative USER.md
copy of their UOA profile. Broader recall is gated on this dependency.

## 4. Learning from ordinary work

Use the durable queue and existing inference attribution. A terminal run, user
correction, document revision/acceptance, rejected result, reopened task or later
verified outcome schedules/coalesces a review over new evidence since a durable
cursor. Include failed and interrupted work, not only completed runs. Structural
events trigger review; the model decides their meaning. A cancellation or edit
is not automatically a negative outcome, and silence is not acceptance.

1. Load currently authorized evidence and relevant existing documents. Preserve
   exact recent turns and source references; expand older summaries when needed.
2. Use an injected utility model to propose no change, a new document, a targeted
   revision, a scoped preference, a contradiction, an outcome, or a procedure.
   Proposals must name source IDs, applicability, uncertainty and expected use.
3. Validate provenance mechanically and judge support in a separate verifier
   pass or against an observed artifact/result. The producing agent's own
   assertion of success is not evidence of success. Reject unsupported certainty.
4. Compare against existing knowledge. Model-judge whether a correction replaces
   a claim, applies only to one person/task, or remains unresolved. Preserve
   superseded versions; do not equate repeated retrieval with independent support.
5. Apply allowed low-risk learned-document changes using conditional version
   updates, or stage an exact diff in the existing ReviewPanel/approval system.
   Human edits win races; stale proposals rebase and revalidate, never overwrite.
6. Reindex, record the source-to-revision/outcome edge, and evaluate later uses.
   Deteriorating revisions can be reverted/disabled with their audit trail intact.

Default autonomy: automatic, verified, reversible additions/updates to
agent-authored examples, experiences and templates within the same audience.
Core instruction edits, overwriting human-authored material, changing procedural
side effects, executable artifacts and wider sharing use existing field/content
approval rules. The same Documents surface exposes history, why a change was
made and undo. No approval for every ordinary sentence, no new approval inbox.
Expose learning enabled/paused in existing agent settings under the same edit
authority; document editing and reading continue when background learning pauses.

Chat acknowledgements of a deliberate change link to its exact document revision.
Source links in chat/Semantic Search and document details provide the in-context
doorways to inspect, correct, suppress or forget learned content. A correction
updates/supersedes the same document; suppress stops active use without destroying
history. Forget immediately tombstones the content and invalidates its dependent
projections/lessons before asynchronous cleanup. Clearly distinguish forgetting
a learned item from deleting the underlying conversation. Neither action may
claim completion while a derived active document still serves the same content.

Keep source-evidence support distinct from model confidence and task outcomes.
Outcome edges reference the exact document revision used, intended task result,
observed acceptance/correction and verifier; success is scoped to the conditions
under which it occurred. Record actual injected/cited retrieval IDs, replacing
English response-phrase heuristics. Ranking combines relevance, validity,
applicability and evidence-backed outcomes; never globally discard failure
lessons, which are useful precisely when avoiding a known failure.

Background work has explicit per-agent/org cost and concurrency caps through
existing budgets and Ledger. Durable claims, idempotency, bounded retries and
source/version fences prevent duplicate lessons across replicas and restarts.
No module-global curator state. Revocation/deletion invalidates pending reviews.
The learner's own automatic revisions and indexing events do not constitute
new independent evidence or advance its learning cursor. Only new external
evidence, an explicit human correction or a requested reevaluation may start a
new review of the same material. Dependency invalidation can withdraw stale
content, but cannot certify the learner's previous output as fresh support.
Prefer event-coalesced review and a bounded idle sweep over rewriting every
document after every turn. Record no-change decisions without posting chat noise.

## 5. Procedures, templates and checklists without recording

"Use this email as our follow-up template" can create a template immediately.
"This worked; handle similar cases this way" can distil a procedure from the
conversation and linked artifacts. Automatic review can discover the same
opportunity from an accepted result. One functional example is sufficient to
create a scoped, evidenced first version; broader reliability requires evals.

Procedure Markdown is the canonical editable guidance. Existing AgentTodo
templates/steps remain the structured execution representation for checklists;
bind each template revision to the document revision from which it was generated.
Use one service for editing/importing either surface and version-lock active
checklist runs. Do not create two independently editable descriptions that drift.
Keep todo_start, progress, approvals and To-dos surfaces. Learning a checklist
does not silently relax its existing publication authority.

When deterministic replay is useful, compile a procedure into the existing
WorkflowTemplate with its source version and tested inputs/outputs. A procedural
document alone grants no tool access and does not install or schedule anything.
Validate compilation against real tool schemas and existing workflow validation,
then use existing install/run approvals. Reuse a vetted immutable skill artifact
only for an executable instruction bundle, with source and references scanned,
snapshots hash-bound and no runtime fetch of replacement instructions.

Retire Record routine entry points and demonstration-only capture/generalization
jobs after importing existing drafts and their provenance. Existing installed
workflows keep running. A truncated old ToolCall preview is insufficient to
reconstruct executable arguments: ask for missing inputs or one authorized test
run in normal conversation; never invent a replay trace or silently begin raw
argument recording for every run. Persist only approved outputs and minimal
redacted evidence needed by ordinary run/task lifecycle instrumentation.

## 6. Nessie and deep.agent responsibilities

| Owner | Work |
| --- | --- |
| deep.agent | Typed learning evidence/proposals; model-based extraction and verification orchestration; budgeted context selection; procedure validation and immutable artifact safety |
| Nessie knowledge/retrieval | Canonical documents, versioned projections, conversation candidates, hybrid queries, source links and permission-aware readers/writers |
| Nessie API/worker | UOA entitlements, disclosure enforcement, inference/Ledger adapters, queue scheduling, jobs, commits, approvals and rollback |
| Nessie admin | Documents/Designer consistency, source links, diffs/history, indexing status, existing checklist/workflow surfaces |

Add small standalone exports to @deep/agent rather than migrating Nessie's whole
runner. Proposed contracts are LearningEvidence, LearningProposal and
LearningVerification, plus distilLearning and verifyLearning entry points taking
injected inference and bounded input. A proposal names document ID, base version,
patch/new Markdown, role, evidence references and requested transition; it never
writes storage or issues an approval itself. Nessie resolves source references
and computes the actual disclosure basis; the model cannot choose those values.

For context selection, extend the existing context planning seam to accept
authorized core parts and retrieval candidates with source IDs, token counts
and role, returning selected references and cost. Nessie alone loads authorized
bytes, records consumption and persists run snapshots. Retrieval scoring stays
in packages/retrieval; the shared helper does not implement a second search
engine. Use interfaces only for these proven consumer seams, not a new generic
document platform or mandatory MemoryStore replacement.

Reuse gateMemoryProvenance and materialized skill verification where their
contracts fit. Do not compress Nessie's conjunctive disclosure basis into
PUBLIC/TENANT/RESTRICTED. Fix authored-source scanning and required verifier
coverage before adopting skill promotion as trusted procedure input. Document
the narrow Nessie adoption honestly in deep.agent's usage and self-improving
guides. No new remember.ninja credential, network service or dual write is
required for this work. Existing deep.agent consumers retain their current APIs.

## 7. Delivery, migration and release gates

Each phase is a coherent, independently verified PR or small series. Shared-core
commits land and are pushed before Nessie pins them; Nessie CI must exercise the
packaged dependency. Do not leave a cross-repository dependency on an unmerged
branch. Every capability ships with its named doorway; machine-only indexing
and learning scheduling use existing document status and history for visibility.

| Phase | Scope and owning seams | Exit condition |
| --- | --- | --- |
| 1. Repair document foundation | FileService + knowledge provider/version writers, shared document authorization and all KB tools | Compose/edit/upload/restore read and search identical Markdown; source basis holds on every read/write; latest model-compatible embeddings exist |
| 2. Core documents and UI | provisioning, agent edit authority, Designer, AgentDocumentsTab, prompt setup | Existing agent instructions migrated once; one edit source; core affects next run; history/undo and restricted documents work |
| 3. History and unified recall | UOA entitlement dependency, conversation index, retrieval and run context | Cross-conversation semantic recall with raw-source expansion and no disclosure widening; backfill and revocation proven |
| 4. Shared learning engine | deep.agent evidence/verification contracts, Nessie adapters/queue and cohort writer cutover | Legacy capture disabled for enabled cohorts before learning writes begin; grounded revisions, races/retries and privacy tests pass |
| 5. Procedures and migration | Knowledge + AgentTodo + WorkflowTemplate services, existing review UI | Natural-language routine distillation works; checklists preserved; recording UI removed without losing installed work |
| 6. Measured rollout | Eval corpus, legacy Thought migration, learning enablement | Learning improves held-out follow-up work; privacy/regression gates pass; old agent-memory writers/readers retired |

Phase 3 indexes only the canonical `Message` source. A hash- and
model-pinned `MessageEmbedding` projection is claimed through the durable queue,
with terminal skipped/failed states, bounded retry, deletion cleanup, and a
tenant-bounded resumable backfill. Retrieval embeds the query once, fuses bounded
FTS and vector candidate sets through the shared retrieval helper, then reloads
each Message and its neighbouring passage. It verifies the current hash,
disclosure basis, private human-source lineage, and the same live UOA viewer
before admitting text into the run's `ConsumedSourceSink`. The initial retrieved
history allowance is 4k estimated tokens and shares prompt space with the
existing core admission boundary; it does not retrieve core-role documents.
Server-supplied channel links remain the source doorway. These deterministic
checks enforce access and provenance; a separate configured quality-model eval
is still required to measure multilingual retrieval quality.

Phase 1 can ship while the UOA authority refactor progresses. No expanded memory
audience ships until that dependency and all affected output/egress gates pass.
Land Phase 3 read-only retrieval before enabling Phase 4 auto-writes; schema
support alone is not a rollout gate. Every phase updates its affected standards.

Backfill file body/chunk projections from canonical bytes with resumable cursors,
per-tenant bounds, content-hash deduplication and accounting. Backfill eligible
conversation passages in the same fashion. Do not backfill ownership or invent
missing private author lineage; unknown evidence stays unverified/restricted.

Preflight existing agent prompts against the configured core-token budget before
migrating their instruction authority. An oversized agent remains on its current
single canonical configuration until an authorized editor resolves it or raises
the valid budget; do not unexpectedly disable it or silently summarize its rules.
Its migration marker prevents concurrent old/new instruction writers. The
oversized-core failure state applies to edits after a successful cutover.

For agent knowledge, Thoughts become a migration input rather than a competing
future authoring store. Preserve source IDs, original scopes, reasoning and
outcome evidence when consolidating useful existing memories into Markdown.
Do not generate one page per old message; raw conversations already own those.
Deduplicate old user-message copies by source reference. Keep personal knowledge
in the appropriate person's My Docs, not a shared agent's core or UOA profile.
Never broaden an old audience just to fit the new home.

Before enabling Phase 4 writes, cut over reads and writes per migrated cohort
with a durable migration marker and stop that cohort's legacy run consolidation
and per-user transcript-to-Thought capture. Migrate its useful existing knowledge
first or leave it on the old path; never enable half a cohort. Phase 6 performs
the remaining bulk migration and final retirement, not the first writer cutover.
No simultaneous active Thought and Markdown writers for the same learned claim.
Keep original rows read-only and excluded from active recall for a bounded,
documented rollback window, then remove redundant content after validation;
outcome/audit references map to the new versions. This replaces the existing
agent-learning duplication, not a permanent compatibility fallback. Rollback
must retain all new Markdown and evidence, and never resurrect deleted or
revoked content. A rollback changes behavior/read selection, not user data.

## 8. Verification and definition of done

Use the existing Turbo/Postgres/mock-LLM and headless Playwright standards.
Export DATABASE_URL for database tests. UI runs use localhost:5455 and the API
uses 5454. Scripted inference proves enforcement; a separate live-model eval
measures language understanding and learning quality. Never describe the former
as proof of the latter. Rebuild the worker after worker changes.

- **Document loop:** create a Markdown email template, see/edit it in Documents,
  find it by paraphrase in a later run, and produce an answer using the correct
  version. Test file upload, compose, targeted edit, restore and index failure.
- **Core authority:** an authorized owner changes voice in Documents/Designer
  and the next unrelated task follows it. A mere notebook editor cannot change
  core behavior via rename, upload, restore, draft write or chat tool.
- **History:** retrieve exact earlier messages with a different human/agent;
  preserve who said what, qualifications and source links across compaction.
- **Learning:** one accepted routine becomes a procedure; a Czech/slang correction
  changes the next attempt; task-specific preferences do not become universal;
  a failed outcome teaches an exception rather than being ranked away.
- **Privacy:** multi-user and multi-author private conversations, revoked
  membership, hidden titles, current/private agent instances, downloads, streams,
  tool arguments, export, cached results and derived revisions never leak.
- **Integrity:** reject poisoned source instructions, unsupported certainty,
  stale base-version edits, duplicate jobs and cross-tenant evidence IDs. Verify
  a deleted source cannot reappear through an old vector, backup rollout marker,
  checkpoint, lesson or pending review; ordinary undo preserves provenance.
- **Procedures:** preserve To-dos and installed workflows; reject fabricated
  replay inputs and unapproved side effects; inspect source/version links.
- **Quality:** run matched baseline/learned/rollback trials on held-out tasks.
  Track supported-claim precision, recall@k, exact-source recovery, stale-claim
  rate, correction retention, task acceptance and persona adherence. Require
  improvement on targeted learning cases without regression on control tasks.
- **Performance:** measure p50/p95 retrieval and response latency, context tokens,
  embedding coverage/index lag, background cost and no-change write rate. Set
  release budgets from baseline measurements, not borrowed vendor benchmarks.

Release gates: all deterministic disclosure/authority/deletion tests pass with
zero forbidden reads/writes, all nine required CI checks are green, UI doorways
are visually verified, and the paired live-model report demonstrates the intended
gain. Keep low-risk learning paused for cohorts without a passing quality report.
Do not claim self-improvement based only on growing memory/document counts.

## Relationship to existing plans

This is the forward plan for agent knowledge and learning. It supersedes the
recording-first UX in [learn-by-demonstration](2026-08-31-learn-by-demonstration.md)
and the competing hidden agent-memory/document authoring direction in Phases D/E
of [Knowledge & Memory Fabric](2026-05-30-knowledge-memory-fabric-plan.md).
It preserves their implemented retrieval substrate and Workflow/To-do machinery;
external-source integrations remain separately scoped. The current
[agent-documents standard](../standards/agent-documents.md) describes shipped
provisioning until the relevant phases explicitly replace it.

Routed dependencies: [ownership](../standards/agent-ownership.md),
[disclosure](../standards/disclosure-boundaries.md),
[file storage](../standards/file-storage.md),
[embeddings](../standards/embeddings.md),
[horizontal scaling](../standards/horizontal-scaling/overview.md),
[UOA authority refactor](2026-09-02-uoa-as-a-service-unification.md),
[testing](../standards/testing.md), and
[build/migration rules](../standards/build-and-release.md).

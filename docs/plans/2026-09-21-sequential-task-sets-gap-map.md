# Sequential task sets: work-item sources and processing gap map

Status: source audit and proposed delivery scope; the task-set capability is not
implemented by this document. Audited 2026-09-21 against `57a2642d2` on `main`.
Source references below refer to that revision. This is not an 80,000-row
benchmark or a verification of a particular Mac, installed model or production
deployment.

The original source audit used spreadsheet research as its worked example.
The accepted scope now covers any supported source of work items, including
manually authored tasks with no dataset or file. The source adapter designs
below are proposals, not claims that new importers already exist.

## Accepted requirements

- Agents can create database-backed task sets with shared instructions and an
  objective. Items may have their own prompts and reference earlier results.
- A task set is an ordered collection of work items, not a spreadsheet job.
  Input may come from CSV, Excel, SQLite, JSON/JSONL, another file format, a
  database/API connector, or manually entered tasks. A data source is optional;
  manual tasks must work without uploading or manufacturing a file.
- Documents already owns file versions. A file-backed set binds to its exact
  document/page ID and version ID; reuse those bytes and that version's access
  boundary rather than introducing another source-versioning system.
- Execution within a set is strictly sequential. Dependencies select which
  earlier results an item consumes; they do not introduce parallel execution.
- A required **processor** selects an authorized model, including a model on an
  approved executor. Model selection and the optional receiving agent are
  separate concepts.
- A **receiver agent** and its follow-up instructions are optional. Results can
  instead be saved deterministically as spreadsheet output or files in a
  selected Documents folder, ready for future processing. No downstream agent
  is needed for saving, formatting a predefined output or advancing the job.
- Nessie's scheduling, capacity admission, cursor advancement, retries and
  persistence are deterministic. The LLM researches, interprets and writes.
- Use the processor's own configured search capability when it has one. Do not
  automatically substitute Nessie's Ledger-backed search. An unavailable
  research capability is a setup/waiting failure, not permission to change
  provider or generate unsupported findings.
- Recover automatically from transient Ollama/host loss and executor/Nessie
  restarts. A person can pause the executor; intentional pause survives
  reconnect/restart and requires explicit resume. Completed items are retained.
- A concrete workload is an Excel file with 80,000 items uploaded into
  Documents, processed by worksheet row, one after another, over a long period
  on local Ollama. Only the current row and explicitly needed context enter a
  model request; the model does not enumerate or remember the whole dataset.

## Conclusion

The missing piece is durable work-item orchestration around existing run and
queue primitives. Nessie already stores files, imports spreadsheets, reads and
writes bounded ranges, runs local inference, and executes authorized tools.
Those parts do not yet compose into a resumable row-processing product.

Uploading an XLSX and asking a chat agent to keep going is insufficient. The
job must retain its source version, next item, attempts, results and delivery
state outside the model's conversation. It must also avoid creating one huge
workflow graph or rewriting an entire workbook after every row.

## One work-item store, several input paths

The common input contract is a bounded, ordered stream of records the source
adapter can persist as work items. **Any source** means the task-set core is
source-independent; a particular format or service still needs a parser or
authorized connector. The processor never guesses how to iterate a foreign
file or keeps an external API cursor in its conversation.

| Input | How it supplies work items |
| --- | --- |
| Manual tasks | A person or agent adds a prompt, optional input payload and optional earlier-result dependencies. No import or dataset is required. |
| CSV / TSV / Excel | Choose headers, fields and, for Excel, worksheet/range; retain the source row locator while assigning a stable item ID and ordinal. |
| SQLite file | Choose an explicitly supported table and columns from an immutable uploaded database snapshot. Record its primary key when present and freeze deterministic order. Do not assume every table has a usable row ID. |
| JSON / JSONL | A JSON array or one JSONL value supplies records directly. A nested object requires an explicit record-path/mapping; a single object can be one item. Preserve nested fields rather than guessing how to flatten them. |
| Other file formats | A supported deterministic adapter converts records into the common store. If the format has no adapter, report that before starting processing. |
| Database / API / other connector | Read with the connector's existing authority, persist bounded pages with stable source keys/revisions, and checkpoint ingestion independently of execution. |

The database-backed table is the shared work-item store. It need not be a live
Excel-like workbook or a separate physical SQL table for every upload. Use
ordinary shared product tables, indexed by task set, stable item ID and
ordinal, with structured input payloads and source references. Keep the
original file in Documents and retain source lineage when a normalized copy
is necessary. A directly readable pinned source can be referenced by each
item without copying its full records again; a supported source that cannot
be addressed directly is deterministically imported into the table. File bytes still go
through `FileService`.

Each item contains or references: its prompt, bounded input, sequence position,
explicit earlier-result dependencies, source locator/revision when applicable,
status, creation and status-change timestamps, attempts, and committed result.
Input records and execution results remain distinct: rerunning a task must not
erase its original input, and model output must not redefine the source key.
Typed metadata can drive table columns while JSON payloads retain nested data;
large values use authorized artifact references instead of unbounded row blobs.

Import/mapping is deterministic once configured. An agent may help author a
mapping or prepare manual tasks, but interpreting every row during ingestion
is not an implicit extra model stage. Preview the extracted items and mapping
so the meaning of one item is visible before a large job starts. Invalid
records have an explicit error and source locator; never drop them silently.

For an uploaded SQLite source, open a consistent read-only snapshot through a
bounded importer; do not execute file-supplied code or extensions. A live
database must be snapshotted/exported consistently before upload. For a remote
source, prefer its stable ordering and snapshot/revision/cursor contract. If
it cannot provide one, materialize the selected records into an immutable
local revision before dispatch rather than promising an exact repeatable
scan over a changing remote table. Ingestion checkpoints and uniqueness keys
prevent duplicates or skipped records after an interrupted import.

The initial job consumes a closed revision of its items. Manual additions are
allowed while drafting, and imports close when their selected source range
is exhausted. An open-ended live feed is a separate ingestion policy with an
explicit finish condition; this finite sequential job must not accidentally
become a never-finishing subscription. Task dependencies reference stable
item IDs and may only point backward in the set's frozen order.

Input and output types are independent. A manual task can write a document;
JSON can produce spreadsheet columns; an Excel row can produce a text file.
Output writers use configured destinations and field mappings, preserve raw
results and source provenance, and require no receiving agent. Generating a
new interpretation of those results is the optional receiver's work.

The existing task-set detail owns its paginated **Items** table for every
source; it shows progress and results, not a second spreadsheet editor. Its
entry points include **Add tasks** for manual work and **Import/connect source**
for external records. The source document's processing entry and originating
conversation open this same view. Dataset browsing, item status and manual
task creation must not depend on having a source file to click.

## Deterministic execution contract

1. Resolve and authorize the set's manual items or configured source adapter.
   Persist an immutable input revision and stable item order. A file source
   pins its version and selected records; a connector pins or materializes a
   consistent selection. Configure the output destination independently.
2. Persist the task-set definition, execution authority, processor pin and
   output policy. Select only earlier items as dependencies.
3. Claim the next eligible item under a per-set database lease and reserve
   capacity for its actual inference resource. One set has at most one active
   item; all sets share the applicable host/provider limits.
4. Read that item's frozen inputs and selected earlier results. Construct a
   bounded processor invocation with its approved search/tool capabilities.
   Reuse the existing execution lifecycle without adding a separate reasoning
   agent to orchestrate the set or save its output. The model never chooses
   which item is next or claims that a database item has completed.
5. Validate the output contract. Plain coherent text is a valid contract;
   named spreadsheet fields require structured validation. Formatting, paths
   and cell mappings come from the configured output contract, not another
   model call. A supported no-finding result is different from a failed search
   or model call.
6. Save the result under a stable item/attempt identity and record any required
   output write durably. Advance only after the required effects are
   acknowledged; a crash retries unfinished persistence rather than assuming
   the row completed. Dependency reads use committed item results.
7. Release capacity and repeat. Temporary host unavailability is a visible
   waiting state, separate from a failed model attempt. After bounded retries,
   a failed item pauses the set for intervention; an explicit skip cannot
   fabricate a result for its dependents.
8. Once the closed input set is resolved, finish the artifact and, if selected,
   enqueue the receiver with a result reference and follow-up instructions.
   Delivery has its own status/retry identity and cannot rerun finished items.

Lease expiry alone is not proof that a model has stopped. Admission must fence
stale execution and confirm termination or use a host-enforced slot before
starting replacement inference. Lowering concurrency does not cancel existing
work silently. These are resource guarantees, not in-memory counters in one
API replica.

## Gaps and existing foundations

### 1. A stored XLSX file is not a row-addressable source yet

Documents upload creates a file page (`api/src/routes/knowledge-base-files.ts`,
lines 193–216). Generic extraction has text/PDF/DOCX support but no XLSX reader
(`packages/knowledge/src/extractable.ts`, lines 22–42). A filename in a chat
attachment inventory does not load all of its cells into context.

There is already an **Open as spreadsheet** action that creates an editable
workbook beside the original (`admin/src/components/features/knowledge/FileNodeViewer.tsx`,
lines 36–40 and 106–115). Existing sheet tools can address rows such as
`125:127` (`packages/knowledge/src/spreadsheet/agent-reads.ts`, lines 76–137).

Required: a task-set source adapter that resolves a pinned file into bounded
rows. Reuse the supported workbook import/read path when its limits fit. A
large file may need a bounded, persistent row index or streaming ingestion;
upload size alone does not prove import capacity. Neither path should expose
the complete 80,000-row file to the model.

Current XLSX import caps are 16 MiB compressed and 256 MiB declared uncompressed;
reads and writes each allow 10,000 cells per call
(`packages/schemas/src/spreadsheet.ts`, lines 13–37). Import still buffers and
loads the workbook (`packages/knowledge/src/spreadsheet/import.ts`, line 221).
There is no categorical 80,000-row rejection: width and content determine
feasibility. The recorded spike's million-cell workbook used 864 MB RSS
(`docs/plans/2026-09-15-spreadsheets-ironcalc/spike-b-xlsx.md`, line 46); that
measurement does not prove a sustained 80,000-item enrichment pipeline.

### 2. Row numbers need a stable source version

The version mechanism already exists: `KnowledgePageVersion` records an
`attachmentId` (`api/prisma/schema.prisma`, model `KnowledgePageVersion`), and
spreadsheet export accepts a specific `versionId` and opens that stored
workbook (`packages/knowledge/src/spreadsheet/export.ts`, lines 35–64).
Therefore the normal file-source pin is `(pageId, versionId)`, with worksheet
and selected range as adapter configuration. **Latest** can choose a version
when the set is created; it must resolve and persist that ID rather than
follow later uploads. The original pin remains the authority after restart.

`withSpreadsheetAtHead` reads the mutable workbook under its page lock
(`packages/knowledge/src/spreadsheet/agent-reads.ts`, lines 29–42). A row address
identifies a position, not an enduring business item. Inserting or sorting
rows while a long job is running changes what row 125 means.

Required: pin the input version and use `(source version, sheet, row)` as the
source locator for a spreadsheet-derived item, alongside its stable task-set
item ID. Store row numbers as spreadsheet row
numbers, explicitly accounting for headers and the selected range. A live
editable source instead needs a stable item key and input-change detection.
Output cell positions need the same protection; freezing the input does not
make writing into a separately edited output workbook safe.

The remaining gap is wiring bounded item reads to that existing version and
retaining its referenced bytes for as long as the set needs them. Pinning is
not an authorization grant: every read still checks the version's current
entitlement and disclosure rules. A removed or unavailable version blocks the
set with its reason; never substitute the newest version automatically.
Generated spreadsheet/file output is a new version or separate output file,
never a mutation of the pinned input. Publishing into an existing document
must detect intervening edits rather than silently overwrite another result.

### 3. Existing workflow execution is not a dataset iterator

No `TaskSet` contract/model/tool was found in the audited Prisma schema,
builtin registry or worker/admin surfaces. Existing ordered workflows are
useful sequencing machinery, but `ensureWorkflowStepRuns` materializes graph
steps individually, and `listWorkflowStepRuns` loads all step rows
(`worker/src/run/workflows.ts`, lines 71 and 311). Each iteration rebuilds prior
step snapshots (`worker/src/control/workflows.ts`, lines 760–794).

There is no fixed graph-step maximum in the inspected schema; the issue is the
eager representation and repeated whole-graph work, not a supposed numerical
step cap. Workflow overlap also permits only ten withheld workflow runs
(`packages/team-admin/src/workflow-concurrency.ts`, line 36), not a bulk work
ledger of 80,000 items.

One chat run cannot substitute for the iterator either: run backstops default
to 45 minutes, 1,000 iterations and 2,000 tool calls, and unattended runs default
to two auto-continuations (`worker/src/run/run-budget.ts`, lines 19–27;
`worker/src/run/execute/continuation.ts`, line 25). These are configurable run
limits, not permission to make the model own multi-day progress.

Required: a source-independent work-item contract, deterministic importers or
connectors, direct manual-task creation, a paged source iterator, durable
ingestion/execution cursors, item attempts/results and
one active-item lease per set. Create bounded execution work on demand through
the existing queue and run lifecycle. Do not create 80,000 prompts in one tool
call, an 80,000-node graph, or 80,000 short-deadline inference attempts.

### 4. A processor model needs an execution context and suitable tools

The current model picker already distinguishes Ledger, personal subscription
and local options (`admin/src/components/features/agents/designer/model-options.ts`).
Local selection requests consent for an agent binding
(`admin/src/components/features/agents/designer/AgentModelField.tsx`, lines
47–55); an arbitrary model/host string is not an execution grant.

The local catalogue filters for text capability
(`api/src/services/local-inference-model-options.ts`, lines 35–51), while the
executor rejects a request containing tools when the model lacks the observed
`tools` capability (`executor/src/local-inference-host.ts`, lines 241–244).

Required: preserve the model dropdown in the product, but bind each job to
explicit execution authority, exact authorized local binding or hosted lane,
and approved tools. Do not temporarily edit an agent's normal model to run a
job. Current local binding is person-owned-agent-specific
(`api/src/services/local-inference-bindings.ts`, lines 154–157); a processor-only
product must reuse an authorized identity or deliberately extend that consent
contract, not silently create another agent or bypass it. Autonomous research
needs a tool-capable processor; deterministic search followed by text-only
synthesis is a distinct supported recipe if offered.
Nessie's worker executes the tools; Ollama generates requests and consumes
their results. Neither a model name nor the processor selection grants web or
document access.

### 5. Local unavailability does not currently mean durable job waiting

At run setup an unavailable local lane is terminalized, with a restart action
(`worker/src/run/execute/run-job.ts`, lines 302–320). This is not a persistent
task set waiting for tomorrow's host availability.

Inference attempts have a five-minute deadline starting at dispatch/enqueue
(`worker/src/run/execute/local-inference-dispatch.ts`, lines 21 and 107).
Transport receipts are short-lived recovery state: terminal server attempts
are swept after one hour, and the local receipt journal holds eight receipts
with a one-hour TTL (`api/src/services/local-inference-transport-sweep.ts`,
lines 3–35; `executor/src/local-inference-receipts.ts`, lines 5–7). They cannot
serve as the long-term result store. Local input context is capped at 8,192
tokens (`packages/schemas/src/local-agent-inference.ts`, line 159), so each
item's research and dependency input must be bounded.

The host loop currently serializes its own calls
(`executor/src/local-inference-host.ts`, lines 181–209), but server leasing is
per host ID and does not count active machine-wide slots
(`api/src/routes/local-inference-attempt-routes.ts`, lines 44–56). Executor and
Desktop enroll separate host identities. Cross-set admission must account for
the physical inference resource instead of assuming these loops together
guarantee a single request on one Mac.

Required: a task-set waiting state above individual runs; bounded retries and
resumption from durable item state; preserved exact model/host pin; no cloud
fallback. Revocation, deleted principals and lost document access must block
with their own reason rather than being treated as ordinary offline recovery.

Existing owner-facing host Pause/Resume routes persist `pausedAt`
(`api/src/routes/local-inference-consent-routes.ts`, lines 172–199); a restarted
daemon cannot clear it by reporting `paused: false`
(`api/src/routes/local-inference.ts`, lines 211–215). The reusable admin control
is `LocalInferenceHostStatus.tsx`. However, both current host runtime factories
pass `isPaused: () => false` (`executor/src/local-inference-runtime.ts`, line
152; `executor/src/direct-local-inference-runtime.ts`, line 221). A local
executor pause action needs to reach durable pause state and the active
request controls rather than merely closing a window.

| Event | Deterministic job behavior |
| --- | --- |
| Ollama becomes unreachable | Retain the current item; back off with a capped retry interval; retry when fresh readiness is established. Offline waiting does not consume the row's model-error retry budget. |
| Executor/API/worker restarts | Recover durable item/result/write state and acquire a new fenced claim. Resume the first unfinished item; do not reset the cursor. |
| Person pauses executor | Persist host pause, stop new dispatches and cooperatively stop the active local request. An uncommitted item remains unfinished; never discard a committed result. Do not recycle the inference slot until the old request is stopped/fenced. |
| Paused executor reconnects | Remain paused. A heartbeat, automatic retry or process restart cannot act as Resume. |
| Person resumes | Revalidate authority and exact processor/source pins, then admit the unfinished item when both set and host permit it. Resuming a host does not override a separately paused set. |
| Retry limit reached for actual processing errors | Pause with the failed item and reason; explicit Retry preserves all completed items. A full start-over is a separate deliberate operation. |

This is job recovery, not an instruction to restart or alter a person's Ollama
installation automatically. Host-native pause and the task-set detail must
show the same persisted reason; local inference runtime recovery alone cannot
substitute for that product state.

### 6. Saving every row through ordinary live-sheet runs is expensive

The first spreadsheet write per agent run requests a safety version
(`packages/knowledge/src/spreadsheet/apply.ts`, lines 90–112). A version renders
the whole workbook to native bytes, XLSX, text projection and canonical hash
(`packages/knowledge/src/spreadsheet/snapshot.ts`, lines 70–90).

Consequently, 80,000 separate row runs each writing the live workbook would
request up to 80,000 whole-workbook safety snapshots. This is a code-derived
scaling concern, not a measured runtime or storage estimate.

Required: persist row results independently, then materialize spreadsheet
output in bounded deterministic batches or an explicitly finalized artifact.
Preserve the existing write chokepoint, access checks, sequence order and
safety guarantees; do not suppress snapshots globally to make the workload
appear cheap. Text/file output can use the result journal directly without
making a workbook mutation for each inference.

### 7. Ollama's own search needs an explicit integration

Ollama does offer its own hosted search and page-fetch APIs. Its official
[web search documentation](https://docs.ollama.com/capabilities/web-search)
(checked 2026-09-21) describes an API key on an Ollama account, separate
`/api/web_search` and `/api/web_fetch` endpoints, and an MCP integration.
Its search-agent example supplies those functions to the model and executes
the returned calls. This is a usable provider capability, not an automatic
property of every local `/api/chat` invocation. Account access is not evidence
of unlimited 80,000-query capacity; no quota or price was verified here.

The audited Nessie local adapter relays authorized chat/tool schemas and
returns tool calls (`executor/src/ollama-chat.ts`, lines 85–120). No native
Ollama search/fetch integration was found in that path. The current generic
Nessie search is a different lane:

Builtin `web_search` is Ledger-routed and carries usage attribution
(`packages/runtime/src/web-search.ts`, lines 116–143 and 180–186;
`docs/standards/web-search.md`). Local inference has no currency charge in its
usage record (`packages/runtime/src/ledger.ts`, lines 403–410), but paid tools
remain separate.

Required: expose the processor's configured Ollama search/fetch capability
through an approved tool/connector path, using existing executor-local MCP
transport where suitable. Keep credentials in that connector/host boundary,
out of prompts. Preserve its identity and surface authentication, quota and
availability failures without falling back to Ledger search. This does not
change the Ledger-only contract of Nessie's existing `web_search` builtin.
If a future implementation instead changes that builtin's routing contract,
it must explicitly update the standing standard in the same change.

### 8. Results, receiver delivery and human controls need a shared surface

Sheet tools already check knowledge access and propagate source disclosure
(`worker/src/run/pa-tools/spreadsheet-access.ts`, `openSpreadsheetPage`). A task
set must retain that basis through item results, saved files, progress
metadata, dependency reads and the receiver's context. Long-running jobs must
revalidate current authority at each dispatch/read/write/delivery boundary.

Required: a result reader with pagination and an optional durable receiver
handoff carrying a result reference, counts and instructions. Do not put
80,000 outputs into one completion message or receiver context. Large
synthesis can consume bounded result pages with persisted intermediate work.

Existing mailbox dispatch has a per-recipient correlation key
(`api/prisma/schema.prisma`, line 4392). Use that durable delivery pattern for
an explicitly selected receiver. `agent_handoff` is for interactive specialist
conversation transfer and rejects unattended work
(`worker/src/run/pa-tools/agent-handoff.ts`, line 72). Existing workflow terminal
notifications catch enqueue failures after bookkeeping, so they are not a
guaranteed delivery queue (`worker/src/control/workflow-run-events.ts`, line
144). Persist the result completion and receiver intent together.

Without a receiver, the selected output writer stores exactly the processor's
result (or a predefined field mapping) through `FileService`/the spreadsheet
write service. Use stable item-derived file/write identities, a configured
destination folder or output sheet, and paginated result browsing; never
create another inference call merely to save a file. Keep raw per-item output
durable even when spreadsheet materialization is delayed or blocked.

The proposed owning surface is **Automation → Task Sets**, reusing one detail
view from an originating conversation status card and the source document's
processing entry when one exists. The same detail permits manual task entry
and source import/connection, with a paginated Items table. Show completed/total
items, current item and source locator, waiting/failure reason, output link and
Pause/Resume/Cancel/Retry. Keep item attempt detail
available without producing a chat message for every row. Documents remains
the home of input/output artifacts, and the receiver stays optional.

## Proposed delivery order

1. **Durable task-set core:** definition, manual work items, source-adapter
   contract, pinned input revision, bounded item iterator, dependency
   validation, execution authority, strict sequential
   claim, result ledger, waiting/failure controls and agent tools. Reuse the
   queue/run machinery and model/tool authorization.
2. **End-to-end source/output slice:** manual task entry plus CSV/Excel,
   SQLite and JSON/JSONL adapters into one paginated item store; Documents
   entry, deterministic table/folder output, conversation progress and shared
   set detail. Other formats/services extend the same adapter contract. Add
   spreadsheet materialization only with safe identity, retry and scale rules.
3. **Local research and optional receiver:** capability-aware processor
   selection, exact local consent, resource admission, Ollama search binding, offline
   recovery and deduplicated final handoff. These are release requirements
   for this user's local-research use case, not optional follow-ups.
4. **Acceptance:** prove a representative 80,000-row source and bounded output
   without doing 80,000 paid searches; run a small real authorized Ollama/tool
   sample for compatibility and rate measurement, then an injected-provider
   full-size recovery/throughput scenario.

## Verification required before claiming the use case works

- Input/import, range access and output export at representative width and
  content, including long text, formulas and the intended workbook format.
- Manual tasks with no file, CSV/Excel, SQLite tables with and without primary
  keys, JSON arrays/nested selections and JSONL all feed the same executor.
  Import restart, duplicate pages, malformed records and changing connector
  sources preserve item identity and counts or stop with an explicit reason.
- Input and output types are independent: manual-to-folder, JSON-to-sheet and
  spreadsheet-to-text use the same deterministic output writer. Nested data
  retains its meaning; no implicit model call guesses record boundaries.
- Exactly one item active in a set across multiple workers, including crash
  takeover, stale leases and host reconnect. Shared host capacity remains
  enforced across several sets using the same machine.
- Crash after result persistence, after output commit, before cursor advance
  and before receiver acknowledgement: no skipped row, duplicate result or
  duplicate downstream effect. An ambiguous model request may execute again;
  never promise exactly-once inference without provider support.
- Sleep/offline longer than an inference deadline, explicit pause/cancel,
  model change, owner/grant revocation, deleted input and quota exhaustion.
- Pause from the executor while inference is active; restart while paused;
  automatic retry while paused; resume host while the set is independently
  paused. None may start work before the applicable explicit resume.
- Input sort/insert/version replacement and output edits: either pinned input
  is unchanged or a conflict blocks explicitly; no positional misdelivery.
- Text-only processor refusal for tool-requiring research, search rate limits,
  missing Ollama search credentials/capability, no automatic Ledger search,
  no-finding results, output validation failures and retry exhaustion.
- Saving text into a Documents folder and configured spreadsheet columns
  invokes no additional model. Receiver absence completes normally; selecting
  a receiver produces one durable handoff, independently retryable on failure.
- Disclosure retained on artifacts, dependency reads and receiver delivery;
  inaccessible results and metadata never leak through the progress surface.
- Headless browser flows from the conversation and document into one detail
  view, with visible waiting/retry states and reachable saved results.

At 10 seconds per item, 80,000 sequential items take about 9.3 days; at one
minute each, about 55.6 days, before downtime and retries. These are arithmetic
scenarios, not measured Ollama performance. They make durable source/result
retention and automatic resource-wait recovery essential to the first release.

This document changes no runtime, UI, MCP contract or migrations. The expanded
accepted scope is recorded here; existing runtime standards and `AGENTS.md`
remain unchanged. No production search, model call or source-data mutation was
performed for the audit or this design update.

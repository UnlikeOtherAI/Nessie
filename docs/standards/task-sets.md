# Sequential task sets

Task Sets live at **Agents → Task sets** (`/agents/task-sets`). A Documents
file version has a **Process with task set** entry. The same set detail owns
configuration, its paginated Items table, progress, processor availability,
Pause/Resume/Cancel/Retry/Skip and the saved output link. Health alerts link
back to this detail. A receiver is optional.

## Execution contract

One set processes one item at a time, in its persisted sequence. Dependencies
may name distinct earlier items in that set. Every dependency must have a
committed result; explicitly skipping it leaves dependents blocked until the
person changes their prerequisites. No model decides which row runs next.

`maxParallelRequests` limits concurrent sets sharing a processor resource.
The smallest active set limit applies to that resource. Local inference also
uses its physical resource limit, default one, shared with ordinary agent
calls and with Desktop/executor hosts running as the same OS account.
The signed resource key and durable local coordinator are documented in
[local Ollama agents](local-ollama-agents.md). They do not govern unrelated
programs calling Ollama directly. Hosted limits govern Task Sets, not unrelated
provider clients. Lowering capacity drains occupied slots.

An item gets a Run and Task only when admitted. Database locks and a partial
unique index enforce one running item per set. The run executor token fences
step-journal and result commits. Result, provenance, item status, cursor,
counts and the next queued wakeup commit in one transaction. A bounded sweep
recovers stranded work; it never imports a whole dataset into queue payloads.

The step journal saves model and tool results. A completed step replays its
receipt. Local generation is additionally idempotent by its durable invocation
identity. A hosted call or executor search whose outcome was lost after
dispatch blocks as `processor_outcome_unknown`; an explicit Retry is needed
because the provider may already have performed the request. Nessie promises
one committed item result, not exactly one remote execution without a receipt.

## Inputs and outputs

Manual tasks carry a client key, prompt, input, earlier dependencies, creation
time and last status time. Reusing a client key with different content is a
conflict. Editing an unfinished task preserves its prior revision; attempts
retain the item/configuration snapshot used for execution.

File sources pin a Documents page, version and attachment. CSV, TSV, XLSX,
SQLite, JSON and JSONL become ordinary items in batches of 200, with a durable
source ordinal. A restart reopens the pinned source and resumes after the
committed ordinal. No new source version is substituted. Manual creation and
paged append are also the input door for other data-source adapters.
The parser and output limits are in [task-set artifacts](task-set-artifacts.md).

Results remain in the database journal. Optional output writes one new text,
JSONL or XLSX file in the chosen Documents folder. XLSX retains source input
and raw result and adds explicitly mapped result fields; it does not modify a
live workbook. The output receipt and deterministic page identity make a
finalization retry recover the same visible file. Output processing is code,
not an agent run.

A receiver names an existing agent, explicit conversation and instructions.
One durable mailbox message carries references to paged results and the
complete disclosure lineage. A delivery failure can be retried independently
of finished items. Broader conversation membership is not permission to
disclose a private dataset there.

## Authority and processors

Task Sets belong to a responsible human. API and native agent tools call the
same `@nessie/team-admin` services, preserving that person's live entitlement.
Agent-authored instructions and item mutations inherit their consumed-source
lineage. Reads stamp that lineage before returning data to a model. Native
tools do not expand paired external MCP credentials' existing scopes; paired
MCP execution needs a separately defined scope.

The processor picker reuses available models and approved local bindings.
Selection pins the local binding revision/model digest or subscription epoch.
Only an explicit processor edit repins it. Each dispatch revalidates authority,
source access, destination/custodian and dependencies. A machine processing a
source must also satisfy its agent restrictions; human-only documents do not
become model input merely because their owner created the set.

Every item, dependency and source-version read enters `ConsumedSourceSink`
before inference. Missing classification blocks dispatch. Saved outputs and
receiver messages retain both basis scopes and exact private authors.

Local processors never fall back to cloud. Processor search uses only the
selected executor's approved `ollama-search` server, exposing
`ollama_web_search` and `ollama_web_fetch`. The host configures
`serve-ollama-search-mcp` and its Ollama account credential. This uses
[Ollama's own search API](https://docs.ollama.com/capabilities/web-search),
whose availability and quota are separate from local generation. Direct
Desktop-only hosts without that executor bridge report setup required.
Missing search does not invoke Nessie's paid search.

Input is checked against the processor context before every inference,
including tool results. Overflow blocks as `input_too_large`: no truncation,
extra summarizer or substituted model. Purpose-specific result headroom is
bounded; an output-length stop is a failure, never a committed partial answer.
Organization budget admission and the deployment run backstop still apply.
A budget policy requesting a different model blocks rather than changing the
pinned processor.

## Recovery and health

Set pause and host/resource pause are independent durable controls. Pausing
requests that the current call stop; resuming one does not resume the other.
Confirmed finished work is retained. A local slot remains occupied until
termination is confirmed, even after cancellation, timeout or worker restart.
Losing the HTTP poll response replays the exact poll token and admission.

Temporary offline/capacity waits do not consume the item's failure allowance.
Actual processor failures retry with bounded delay up to the configured
attempt allowance. Explicit Retry starts a new allowance without renumbering
history. Unknown termination, revoked authority, unusable search, dependency
failure, context overflow and exhausted retries have durable remedy states.
Alerts are deduplicated per health transition. Continuous unpaused offline
waiting alerts after 30 minutes; routine capacity waits and intentional pauses
do not alert.

## Verification

`worker/src/task-sets/*.test.ts` exercises competing database clients, shared
capacity, ordered dependencies, fence takeover, receipt replay and health
transitions. Run it through Turbo with `DATABASE_URL`:
`pnpm exec turbo run test:task-sets --filter=@nessie/worker`.
The normal worker suite also discovers these tests.

Knowledge tests stream 80,000 JSONL records and an 80,000-row XLSX, verify
restart, selected sheets and read-only SQLite, and replay output receipts.
Local-host/executor tests exercise signed resource identity, shared capacity,
pause persistence, lost poll responses and uncertain termination.

The headless UI evaluation is described in
[task-sets-e2e](../testing/task-sets-e2e.md) and runs in Browser Suites. Its
stateful transport fixture proves production UI contracts, not live Ollama
quality or an installed Mac's performance. Live model/device validation must
be reported separately; synthetic large-file checks are not an 80,000-prompt
live model run.

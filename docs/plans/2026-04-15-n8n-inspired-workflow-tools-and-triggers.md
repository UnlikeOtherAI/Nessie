# n8n-Inspired Workflow Tools and Triggers for Nessie

> Status: proposal

## Goal

Use the n8n execution model as the reference point for Nessie workflows, while preserving Nessie’s core distinction between:

- deterministic workflow execution,
- first-class agent nodes for AI reasoning,
- tool registry and policy enforcement,
- channel and DM-native human interaction.

This document builds on:

- [docs/research/n8n-tools-nodes-connectors-safe-data-passing.md](../research/n8n-tools-nodes-connectors-safe-data-passing.md)
- [docs/plans/2026-04-07-workflow-builder.md](./2026-04-07-workflow-builder.md)
- [docs/tool-registry-spec.md](../tool-registry-spec.md)
- [docs/the-agents.md](../the-agents.md)
- [docs/external-tool-integration.md](../external-tool-integration.md)

## Current-State Constraints

This proposal is a target-state design, not a description of what the repo already does today.

The current implementation has several hard limits that any delivery plan must respect:

- the workflow graph contract is still `steps[]` only, with no first-class edges or branch semantics in [api/src/contracts.ts](../../api/src/contracts.ts)
- the worker currently executes only `agent_task` and `environment_launch` step types in [worker/src/control/workflows.ts](../../worker/src/control/workflows.ts)
- the workflow designer canvas currently supports only `trigger`, `tool`, and `agent` node types in [admin/src/pages/WorkflowDesignerPage.tsx](../../admin/src/pages/WorkflowDesignerPage.tsx)
- the trigger editor currently supports `manual`, `scheduled`, `interval`, `webhook`, and `event`, but not `message-pattern` or `error`, in [admin/src/components/features/triggers/TriggerEditorDialog.tsx](../../admin/src/components/features/triggers/TriggerEditorDialog.tsx)
- the current built-in worker tool surface is still limited to `document_read`, `web_fetch`, `web_search`, and `spawn_subtask` in [packages/runtime/src/builtin-tools.ts](../../packages/runtime/src/builtin-tools.ts) and [worker/src/run/tools.ts](../../worker/src/run/tools.ts)

Because of that, this document must be read in two layers:

1. **Near-term MVP**: a trigger/tool/agent workflow slice that fits the current admin, API, runtime, and worker architecture.
2. **Target-state expansion**: richer node families and connector breadth after the graph model and designer become first-class.

## Design Rules

To avoid bad implementations, the following rules are mandatory:

- do not describe target-state node types as if they already exist in the current designer
- do not add new tool names that conflict with the existing tool registry vocabulary without an explicit migration path
- do not require graph semantics the current `steps[]` contract cannot represent without first extending the contract
- do not require agent pages or tools pages to expose configuration they do not currently support without specifying the UI work needed
- do not treat “watch for change” as magic; every watcher must define its checkpoint, diff basis, and dedupe strategy
- do not conflate free-form human input with approval-gated resumption
- do not introduce generic outbound network or secret-injection primitives without explicit policy and tenancy boundaries

## Required Admin/UI Work

This proposal is not implementable in the current admin without new UI surfaces.

Minimum required admin changes:

- add a node inspector/properties surface in the workflow designer
- persist typed per-node config in `WorkflowTemplate.graph`, not just `workflowDesigner` metadata
- expose workflow-tool parameter editing and input/output mapping
- expose step input/output detail in workflow run detail
- expand the trigger editor only when new trigger kinds are actually supported end to end

The current designer only round-trips:

- `title`
- `type`
- `sourceId`
- `meta`
- `position`
- `outgoingNodeIds`

That is insufficient for configurable tool steps like `http.fetch`, `state.get`, `change.detect`, or `message.send`.

## What We Should Copy from n8n

The load-bearing ideas to carry over are:

- one clear execution model for data moving between nodes,
- a strict separation between triggers and action nodes,
- deterministic control-flow primitives,
- connector-style nodes/tools for external systems,
- aggressive data minimisation between steps,
- queue-friendly, resumable executions,
- explicit state and idempotency handling,
- strong security around code execution and outbound fetching.

## What We Should Not Copy Directly

Nessie should not turn everything into generic code nodes or opaque plugin blobs.

We should keep these as first-class Nessie concepts instead of flattening them into generic n8n-style nodes:

- **Agent node** for LLM reasoning and tool use
- **Eval pattern** via Agent + Router
- **Human Input node** for channel/DM pause-and-resume
- **Project node** for filesystem scope injection
- **Secret node** for runtime secret resolution
- **Policy enforcement** before any tool invocation

## Core Model

The clean model for Nessie is:

1. A **trigger** starts a workflow run.
2. The workflow passes a canonical payload between nodes.
3. **Deterministic tool nodes** fetch, extract, transform, persist, and notify.
4. **Agent nodes** do classification, summarisation, prioritisation, drafting, and decision support.
5. **Control nodes** route, fork, join, wait, and merge without involving an agent unless needed.
6. **Human Input nodes** pause execution when a person must answer or approve.

This keeps “website changed”, “new GitHub release”, and “send a DM” in the deterministic workflow layer, while keeping interpretation and drafting in the agent layer.

## Delivery Model

This proposal should be implemented in stages:

### Stage A: Real MVP on current architecture

Supported node families:

- Trigger
- Tool
- Agent

Supported execution model:

- single-entry workflows
- sequential execution
- explicit step outputs persisted between steps
- no general branching yet

Supported workflow value:

- trigger a workflow
- run a deterministic tool step
- pass the result into an agent step
- let the agent produce work
- observe the run in admin

Required admin capabilities in Stage A:

- create a Trigger/Tool/Agent workflow in the existing designer
- configure node-specific parameters in a node inspector
- install and trigger the workflow from current admin pages
- inspect step input/output in workflow run detail

### Stage B: Graph semantics upgrade

Only after the workflow graph becomes edge-aware should we add:

- Router
- Fork
- Join
- Wait
- Human Input
- Project
- Secret

### Stage C: Rich connector and trigger breadth

After Stage A and B are stable, expand into:

- message-pattern
- error-triggered workflows
- email/calendar/file-change triggers
- richer connector packs
- visual diff / screenshot capabilities

## Canonical Payload Shape

There are two payload layers to be explicit about:

1. **Current contract** for the live repo
2. **Target-state item model** inspired by n8n

### Current contract

Today the workflow runtime persists:

- `workflowRun.input`
- `workflowStepRun.input`
- `workflowStepRun.output`
- `workflowRun.output`

as JSON objects in Postgres.

That means the Stage A implementation should use an explicit JSON object contract, for example:

```ts
type WorkflowStepPayload = {
  trigger?: {
    id?: string;
    type: string;
    receivedAt?: string;
  };
  input?: Record<string, unknown>;
  steps?: Record<string, {
    input?: Record<string, unknown>;
    output?: Record<string, unknown>;
    status?: string;
  }>;
};
```

### Target-state item model

To borrow n8n’s strongest idea, Nessie may later move to a single canonical payload shape between nodes.

Recommended shape:

```ts
type WorkflowItem = {
  json: Record<string, unknown>;
  binary?: Record<string, {
    artifactId: string;
    mimeType?: string;
    fileName?: string;
    sizeBytes?: number;
  }>;
  pairedItem?: number | { item: number };
};

type WorkflowPayload = {
  items: WorkflowItem[];
  meta: {
    trigger: {
      type: string;
      id?: string;
      receivedAt: string;
    };
    runId: string;
    workflowId: string;
  };
};
```

Rules:

- In Stage A, every step receives and emits JSON object payloads.
- In target state, every node receives and emits `items[]`.
- Large files should be passed by artifact reference, not inlined blobs.
- Secrets must never be copied into `items`.
- Agent nodes should receive only explicitly selected fields, not raw upstream payloads by default.
- Nodes that expand or split data must preserve `pairedItem` metadata so downstream references remain deterministic.

The item-array model must not be treated as already implemented until the runtime, storage, run detail UI, and step binding semantics are upgraded to support it.

## Trigger Types

Triggers should answer only one question: **what wakes the workflow up?**

Recommended trigger set:

| Trigger type | Purpose | Day 1 | Notes |
|---|---|---|---|
| `manual` | Run from UI or API | yes | Required for testing and ad hoc runs |
| `scheduled` | Cron-based execution | yes | Core polling primitive |
| `interval` | Simpler repeat cadence | yes | Good for lightweight watchers |
| `webhook` | External HTTP event | yes | GitHub, Stripe, custom systems |
| `event` | Internal platform event | yes | `task.review_passed`, `run.failed`, `message.created` |
| `message-pattern` | Channel/DM message match | later | Implement as a new trigger kind or an event-derived pattern, not current state |
| `error` | Run or workflow failure | later | Alerting, escalation, retry workflows |
| `approval-resolved` | Resume after approval/human response | later | Separate from Human Input |
| `email-received` | Inbound email | later | May initially arrive through webhook/event bridge |
| `calendar` | Time window or calendar event | later | Useful but not core |
| `file-or-object-changed` | Storage/object-store change | later | Better as native event if provider supports it |

### Trigger rollout

The trigger table above is the target taxonomy. The implementation order should be:

1. `manual`
2. `scheduled`
3. `interval`
4. `webhook`
5. `event`
6. `message-pattern`
7. `error`

`message-pattern` and `error` should not be treated as already-live Day 1 features in the current admin until the trigger editor, schemas, and worker trigger dispatch support them end to end.

`approval-resolved`, `email-received`, `calendar`, and `file-or-object-changed` are explicitly post-MVP.

### Important rule: “change detected” is not a trigger type

A “website changed” or “new repo release” workflow should usually be a pattern, not a primitive trigger:

`scheduled` → `state.get` → `http.probe` → `change.detect` → conditional fetch → agent/tool follow-up

This keeps the trigger model small and the behaviour explicit.

## Node Families

Borrow the n8n separation, but map it into Nessie terms:

| Family | Nessie form | Should it be a tool? |
|---|---|---|
| Trigger | Trigger node | no |
| Control flow | Router, Fork, Join, Wait, Merge | no |
| Human interaction | Human Input | no |
| Scope/config | Project, Secret | no |
| External I/O | Tool node | yes |
| Data shaping | Tool node or native helper | usually yes if reusable |
| AI reasoning | Agent node | no |

### Current implementation note

In the current repo, only these three are immediately compatible with the existing designer and worker:

- Trigger
- Tool
- Agent

Everything else in this section is target-state and requires:

- graph contract changes,
- designer interaction model changes,
- worker execution changes,
- admin run-detail changes.

## Tool Families We Should Have

Tools should be reusable, deterministic capabilities that either:

- talk to external systems,
- transform data in a predictable way,
- maintain workflow state,
- send outputs to people or other systems.

## Tool Naming Rules

To keep the tool catalog coherent:

- the near-term MVP should keep the repo's current underscore naming convention
- future namespacing is optional and should happen only as an explicit migration, not implicitly inside the MVP
- connector-backed tools should preserve connector namespace such as `github.releases.latest`
- workflow composition must use the existing `invoke_workflow` naming from [docs/plans/2026-04-07-workflow-builder.md](./2026-04-07-workflow-builder.md)
- any overlap with current built-ins (`web_fetch`, `web_search`) must be handled explicitly, either by migration, aliasing, or replacement

### Current builtin mismatch

The current builtin/runtime tool surface is still anchored around today’s IDs and contracts.

The proposal’s tool names should therefore be read as:

- **current IDs** where the capability already exists,
- **proposed future IDs** where the capability does not yet exist.

In particular:

- `web_fetch` exists today
- `web_search` exists today
- `send_message` already exists in the broader builtin/runtime surface and should keep its current contract unless a migration is defined
- `state_get`, `state_put`, and `change_detect` are the near-term workflow-tool additions
- `http_probe`, `invoke_workflow`, and a unified `message.send` contract are post-MVP unless implemented with an explicit migration path

### 1. Retrieval and probing

These cover the “fetch any type of stuff from the internet” requirement.

| Tool | Purpose | Notes |
|---|---|---|
| `web_fetch` | Fetch URL body + headers + status | Base primitive for public web access in the MVP |
| `http_probe` | Cheap URL check using HEAD/metadata/fingerprint | Use before full fetch when watching for changes |
| `http_request` | Full REST call with method, headers, body, auth binding | More general than `web_fetch`; post-MVP unless explicitly added |
| `rss.fetch` | Read RSS/Atom feeds | High-value for change detection without scraping |
| `sitemap.fetch` | Read sitemap URLs | Useful for site monitoring flows |
| `file.download` | Fetch remote file to artifact storage | Large content should become artifact refs |
| `webpage.screenshot` | Capture page image | Optional, useful for visual diff workflows |

### Required egress and SSRF policy

All outbound workflow tools must go through a policy-checked egress layer.

Minimum requirements:

- deny localhost, private IPs, link-local ranges, metadata endpoints, and DNS-rebinding targets
- apply approved-domain or approved-host policy before authenticated outbound requests
- cap redirect count, response size, and fetch timeout
- store auth as `secretRef` bindings, never inline headers/secrets in the graph
- require approval for non-approved or privileged outbound targets when policy demands it

These rules should extend the existing worker fetch safety baseline rather than bypass it.

### 2. Extraction and parsing

These should turn fetched content into narrow, structured data.

| Tool | Purpose | Notes |
|---|---|---|
| `html.extract` | CSS/XPath/text extraction from HTML | Core replacement for brittle ad hoc scraping inside agents |
| `json.extract` | JSONPath/schema projection | Narrow API responses before downstream use |
| `text.extract` | Regex or marker-based extraction | Good fallback for semi-structured text |
| `feed.normalize` | Normalize feed entry shape | Useful across RSS/source connectors |
| `fingerprint.compute` | Stable hash of selected content | Basis for change detection |

### 3. State, checkpointing, and idempotency

These are essential if we want robust watchers.

| Tool | Purpose | Notes |
|---|---|---|
| `state_get` | Load last-seen cursor, hash, timestamp, or checkpoint | Workflow-installation scoped in the MVP |
| `state_put` | Persist updated checkpoint | Only after successful processing |
| `change_detect` | Compare current value to prior state | Returns structured diff summary |
| `dedupe.check` | Guard against duplicate delivery or repeated action | Useful for webhook workflows |
| `dedupe.mark` | Record delivery IDs / processed keys | Needed for replay-safe ingestion |

Checkpoint and dedupe storage must be explicitly scoped:

- workflow-installation scoped for watcher checkpoints
- trigger-delivery scoped for replay/dedupe data
- tenant-scoped and auditable

Recommended MVP storage model:

- `workflow_state_entries`
- unique key on `(workflow_installation_id, key)`
- JSON value payload
- no cross-installation sharing by default
- writes only through deterministic workflow tools or explicit runtime services

### 4. Communication and delivery

These should be first-class, because workflow outputs often go to people.

| Tool | Purpose | Notes |
|---|---|---|
| `send_message` | Send to channel, DM, or thread | Keep the current contract in the MVP |
| `email.send` | Send outbound email | Useful for fallback notifications |
| `webhook.respond` | Send explicit webhook response payload | For response-node style flows |
| `event.emit` | Emit internal event | Lets one workflow wake another |
| `invoke_workflow` | Call another workflow | Core composition primitive |

### 5. Connector tools

These are domain-specific wrappers over external APIs and should come from the tool registry / MCP / API connector system:

| Tool family | Examples |
|---|---|
| GitHub | `github.releases.latest`, `github.issue.create`, `github.pr.list` |
| Stripe | `stripe.invoice.get`, `stripe.customer.lookup` |
| Slack / chat | `chat.message.post`, `chat.channel.lookup` |
| Notion / docs | `notion.page.create`, `notion.database.query` |
| Storage | `s3.object.get`, `gcs.object.put` |

Rule:

- prefer a domain connector when the API is stable and important,
- fall back to `http.request` when the connector does not exist yet.

### 6. Optional data shaping tools

Some transformations are common enough to deserve reusable tools instead of forcing agent nodes or ad hoc code:

| Tool | Purpose |
|---|---|
| `fields.select` | Keep only named fields |
| `fields.map` | Rename/project fields into a contract |
| `list.chunk` | Split item arrays into smaller batches |
| `list.flatten` | Flatten nested collections |
| `json.parse` | Parse raw JSON text safely |
| `text.template` | Render deterministic templates from structured fields |

These should stay deterministic and side-effect free.

## What Should Stay Out of the Tool Layer

These should be native workflow behaviour, not tools:

- branching
- merge/wait/fork/join
- retry/backoff
- timeout handling
- approval wait states
- secret resolution
- project scope injection
- agent prompting and evaluation
- approval resolution

If we turn these into tools, we make the workflow engine harder to reason about and harder to audit.

## AI / Agent Boundary

The n8n lesson is not “everything should be code.” For Nessie the right lesson is “everything deterministic should stay deterministic.”

Agent nodes should be used for:

- classification
- summarisation
- prioritisation
- drafting
- semantic extraction when deterministic parsers are insufficient
- deciding what to tell a human

Agent nodes should not be the first place we do:

- raw web fetching
- cheap change detection
- idempotency checks
- simple field projection
- message transport

Agent nodes also must not be the place where plaintext secrets are exposed or where approval-protected actions are resumed.

## Human Input and Approval Boundary

`Human Input` is for collecting data from a person.

It is not the same thing as approval gating.

Rules:

- `Human Input` may capture text, choices, or clarifications from a channel or DM
- `Human Input` may resume a workflow with user-provided data
- `Human Input` must not by itself authorize a gated side effect
- approval-protected actions must resume only through the approval system and its continuation-token flow

If a workflow needs both:

1. collect a human response,
2. then request approval for a sensitive action,

those must be represented as two separate concepts in the runtime.

## Secret and Artifact Boundary

The workflow graph may reference secrets and artifacts, but it must not contain plaintext secret material or raw object-store coordinates.

Rules:

- workflow graphs store only opaque `secretRef`-style references
- secret resolution happens at the specific tool or runner boundary that needs it
- no workflow-level blanket env injection across all nodes
- artifact payloads use opaque artifact IDs with tenant scope, lease/signed resolution, and size/type limits
- no direct bucket keys, filesystem paths, or object-store credentials in workflow payloads

Recommended pattern:

1. Fetch and narrow data deterministically.
2. Pass only the selected contract into the agent.
3. Let the agent produce structured output.
4. Route on that output.
5. Send or persist deterministically.

This matches the user request: the AI part is the processing layer, but the workflow plumbing is still clean, proven, and reproducible.

## Recommended MVP

If we want a small first version that already supports useful workflows, build these first.

### MVP triggers

- `manual`
- `scheduled`
- `interval`
- `webhook`
- `event`

### MVP workflow step types

- `tool_call`
- `agent_task`

### MVP designer node families

- Trigger
- Tool
- Agent

### MVP tools

- `web_fetch` as the initial fetch primitive
- `web_search` where search is needed
- `state.get` or an equivalent checkpoint lookup service
- `state.put` or an equivalent checkpoint write service
- `change.detect`

### MVP mandatory runtime capabilities

- persist step outputs and expose them to downstream steps
- deterministic step input mapping into tool calls
- deterministic step input mapping into agent prompts
- installation-scoped checkpoint storage for watcher workflows
- admin run detail that can show step input and output

### Not in MVP

- general branching
- Router/Fork/Join execution
- Wait/Human Input suspension
- Secret/Project graph injection
- `message-pattern`, `error`, `approval-resolved`, `email`, `calendar`, and `file-change` trigger families
- full connector marketplace breadth

## Example Workflow Patterns

### 1. New GitHub release watcher

```text
scheduled
  -> state.get(lastReleaseId)
  -> github.releases.latest
  -> change.detect
  -> Router(changed?)
  -> Agent(summarise release notes)
  -> message.send(target=channel)
  -> state.put(lastReleaseId)
```

### 2. Generic website change watcher

```text
scheduled
  -> state.get(lastFingerprint)
  -> http.probe
  -> Router(possiblyChanged?)
  -> http.fetch
  -> html.extract
  -> fingerprint.compute
  -> change.detect
  -> Router(changed?)
  -> Agent(summarise change)
  -> message.send(target=dm)
  -> state.put(lastFingerprint)
```

### 3. Webhook triage and escalation

```text
webhook
  -> fields.select
  -> dedupe.check
  -> Router(duplicate?)
  -> Agent(classify severity)
  -> Router(severity)
  -> message.send(target=channel or dm)
  -> event.emit
  -> dedupe.mark
```

## Implementation Guidance

### 1. Keep trigger taxonomy small

Do not create a separate trigger for every source-specific behaviour. “GitHub release posted” should be:

- a GitHub webhook trigger if available, or
- a scheduled polling workflow if not.

### 2. Keep the transport layer explicit

In the MVP, use the existing `send_message` contract and do not introduce a parallel delivery API.

If a future transport unification happens, it should migrate from the current fields:

- `channelId`
- `threadId`
- `targetUserId`

to a typed target object in a separate compatibility phase.

### 2a. Keep the graph contract explicit

If the graph remains `steps[]`, then the implementation must explicitly define:

- how step order is derived,
- how trigger nodes map to executable steps,
- how outputs from one step are bound into the next step,
- which features are unsupported until edges become first-class.

Do not imply n8n-like branch semantics before the graph contract can actually encode them.

The graph contract must also be upgraded to carry typed node config. A visual canvas that only stores labels and positions is not sufficient for executable workflow tools.

### 3. Reduce data before agent hops

Borrow n8n’s “Keep Only Set Fields” principle:

- add deterministic narrowing before every Agent node,
- default agent inputs to selected fields only,
- never pass full webhook payloads or fetched pages into agents unless explicitly requested.

### 4. Make state explicit

Watcher workflows are only reliable if state is first-class. `state_get` and `state_put` are not optional add-ons; they are the foundation of:

- page-change detection,
- new-release detection,
- replay-safe webhook handling,
- idempotent notifications.

The state model must specify scope. Default recommendation:

- installation-scoped for workflow checkpoints
- trigger-delivery-scoped for dedupe keys
- never channel-global by default

Template-level trigger definitions must also be explicit about materialization:

- `WorkflowTemplate.triggers` stores the template defaults created in the designer
- installation creates concrete `AgentTrigger` rows from those defaults
- existing installations are not silently rewritten when the template later changes unless an explicit sync operation exists

### 5. Prefer connector tools over agent improvisation

If a workflow needs GitHub, Stripe, Notion, or another stable SaaS, the long-term solution should be:

- tool registry entry,
- typed connector contract,
- policy enforcement,
- deterministic output schema.

The agent should reason about connector results, not simulate the connector.

### 6. Do not overstate current admin support

Until the tools page, agent designer, and workflow designer are registry-backed and parameter-aware:

- do not claim workflow tools are editable from current admin surfaces
- do not claim new trigger kinds are supported until the trigger editor and schemas support them
- do not assume the current tool catalog can select or configure registry-defined workflow tools without additional UI work

## Proposed Delivery Order

### Phase 1

- graph contract upgrade for sequential step output passing
- typed node config persisted in workflow templates
- `tool_call` step type in the worker
- sequential Trigger/Tool/Agent designer support
- MVP triggers already supported by current runtime
- state/checkpoint storage
- trigger defaults materialized into installation-scoped `AgentTrigger` rows
- step input/output inspection in workflow run detail
- one verified end-to-end watcher workflow

### Phase 2

- richer extraction tools
- transport contract migration if we still want unified delivery naming
- `invoke_workflow`
- connector families via MCP / custom API connectors
- tools/agent admin surfaces moved toward registry-backed selection and editing

### Phase 3

- graph edges as first-class workflow contract
- Router/Fork/Join semantics
- Wait/Human Input suspension
- Project/Secret node semantics
- file/object-change triggers
- email/calendar triggers
- visual diff and screenshot tools
- advanced batching/throttling helpers

## Acceptance Criteria

The proposal is only “implemented” when all of the following are true:

1. A workflow can be created in the designer using Trigger, Tool, and Agent nodes.
2. The workflow can be installed and triggered from the current admin UI.
3. A deterministic tool step can fetch external data.
4. The fetched data is persisted as step output and passed into a downstream agent step.
5. The downstream agent produces visible work, such as a message, task, or run output.
6. The run detail page shows enough input/output detail to debug the flow.
7. At least one end-to-end scenario is verified through UI/E2E, not just unit tests.
8. The implementation does not break existing trigger creation, workflow installation, or agent execution flows.
9. Outbound fetches remain protected by the existing or stricter SSRF/egress policy.
10. Secrets and artifacts are handled through opaque references, not plaintext workflow payloads.

## Bottom Line

The right n8n lesson for Nessie is:

- keep triggers small and explicit,
- keep control flow native,
- make tools deterministic and reusable,
- make state first-class,
- keep AI in agent nodes, not in every step.

For the specific workflows you described, the highest-value primitives are not “more AI tools.” They are:

- `scheduled` / `webhook` / `event` triggers,
- `web_fetch` plus later `http_probe`,
- extraction tools,
- state and dedupe tools,
- `send_message` in the current contract,
- agent nodes for interpretation and drafting after the deterministic steps are done.

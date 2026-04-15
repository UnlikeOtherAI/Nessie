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

## Canonical Payload Shape

To borrow n8n’s strongest idea, Nessie workflows should pass a single canonical payload shape between nodes.

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

- Every node receives and emits `items[]`.
- Large files should be passed by artifact reference, not inlined blobs.
- Secrets must never be copied into `items`.
- Agent nodes should receive only explicitly selected fields, not raw upstream payloads by default.
- Nodes that expand or split data must preserve `pairedItem` metadata so downstream references remain deterministic.

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
| `message-pattern` | Channel/DM message match | yes | Keyword, regex, mention, or scope-bound message handler |
| `error` | Run or workflow failure | yes | Alerting, escalation, retry workflows |
| `approval-resolved` | Resume after approval/human response | later | Could also be modelled as Human Input resume |
| `email-received` | Inbound email | later | May initially arrive through webhook/event bridge |
| `calendar` | Time window or calendar event | later | Useful but not core |
| `file-or-object-changed` | Storage/object-store change | later | Better as native event if provider supports it |

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

## Tool Families We Should Have

Tools should be reusable, deterministic capabilities that either:

- talk to external systems,
- transform data in a predictable way,
- maintain workflow state,
- send outputs to people or other systems.

### 1. Retrieval and probing

These cover the “fetch any type of stuff from the internet” requirement.

| Tool | Purpose | Notes |
|---|---|---|
| `http.probe` | Cheap URL check using HEAD/metadata/fingerprint | Use before full fetch when watching for changes |
| `http.fetch` | Fetch URL body + headers + status | Base primitive for public web access |
| `http.request` | Full REST call with method, headers, body, auth binding | More general than `http.fetch`; registry/policy controlled |
| `rss.fetch` | Read RSS/Atom feeds | High-value for change detection without scraping |
| `sitemap.fetch` | Read sitemap URLs | Useful for site monitoring flows |
| `file.download` | Fetch remote file to artifact storage | Large content should become artifact refs |
| `webpage.screenshot` | Capture page image | Optional, useful for visual diff workflows |

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
| `state.get` | Load last-seen cursor, hash, timestamp, or checkpoint | Workflow-scoped or installation-scoped |
| `state.put` | Persist updated checkpoint | Only after successful processing |
| `change.detect` | Compare current value to prior state | Returns structured diff summary |
| `dedupe.check` | Guard against duplicate delivery or repeated action | Useful for webhook workflows |
| `dedupe.mark` | Record delivery IDs / processed keys | Needed for replay-safe ingestion |

### 4. Communication and delivery

These should be first-class, because workflow outputs often go to people.

| Tool | Purpose | Notes |
|---|---|---|
| `message.send` | Send to channel, DM, or thread | One tool with target type, not separate channel/DM tools |
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
- `message-pattern`
- `error`

### MVP tools

- `http.probe`
- `http.fetch`
- `html.extract`
- `json.extract`
- `fingerprint.compute`
- `state.get`
- `state.put`
- `change.detect`
- `message.send`
- `event.emit`
- `invoke_workflow`

### MVP native nodes

- Trigger
- Agent
- Tool
- Router
- Fork
- Join
- Wait
- Human Input
- Project
- Secret

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

### 2. Keep the transport layer unified

For human delivery, prefer one `message.send` tool with a target contract:

```ts
type MessageTarget =
  | { type: 'channel'; channelId: string }
  | { type: 'dm'; recipientId: string }
  | { type: 'thread'; threadId: string };
```

This avoids a fragmented tool catalog like `send_to_channel`, `send_dm`, `send_thread_reply`.

### 3. Reduce data before agent hops

Borrow n8n’s “Keep Only Set Fields” principle:

- add deterministic narrowing before every Agent node,
- default agent inputs to selected fields only,
- never pass full webhook payloads or fetched pages into agents unless explicitly requested.

### 4. Make state explicit

Watcher workflows are only reliable if state is first-class. `state.get` and `state.put` are not optional add-ons; they are the foundation of:

- page-change detection,
- new-release detection,
- replay-safe webhook handling,
- idempotent notifications.

### 5. Prefer connector tools over agent improvisation

If a workflow needs GitHub, Stripe, Notion, or another stable SaaS, the long-term solution should be:

- tool registry entry,
- typed connector contract,
- policy enforcement,
- deterministic output schema.

The agent should reason about connector results, not simulate the connector.

## Proposed Delivery Order

### Phase 1

- canonical workflow payload shape
- MVP triggers
- MVP tools
- `message.send` unified delivery tool
- state/checkpoint storage

### Phase 2

- connector families via MCP / custom API connectors
- richer extraction tools
- artifact storage for large fetches and binaries
- error-trigger and failure-escalation flows

### Phase 3

- file/object-change triggers
- email/calendar triggers
- visual diff and screenshot tools
- advanced batching/throttling helpers

## Bottom Line

The right n8n lesson for Nessie is:

- keep triggers small and explicit,
- keep control flow native,
- make tools deterministic and reusable,
- make state first-class,
- keep AI in agent nodes, not in every step.

For the specific workflows you described, the highest-value primitives are not “more AI tools.” They are:

- `scheduled` / `webhook` / `event` triggers,
- `http.probe` / `http.fetch`,
- extraction tools,
- state and dedupe tools,
- a unified `message.send`,
- agent nodes for interpretation and drafting after the deterministic steps are done.

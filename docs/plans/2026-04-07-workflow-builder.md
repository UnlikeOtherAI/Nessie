# Workflow Builder & Agent Design

**Date:** 2026-04-07
**Status:** Design

---

## Overview

Two closely related features:

1. **Agent design page** — create and configure agents (replacing the human-user concept from Slack-style UIs)
2. **Workflow builder** — a canvas-based editor for defining agentic workflows, where each workflow is registered as a callable tool

---

## Core Design Decision: Workflows Are Tools

A workflow is not a user, agent, or session. It is a **tool** registered in the tool catalog:

```
invoke_workflow(workflowId: string, inputs?: Record<string, unknown>) → WorkflowResult
```

Any agent with `invoke_workflow` in its tool list can trigger any workflow it has access to. The workflow engine executes the node graph deterministically and returns a result to the calling agent. Workflow nesting is supported — a Tool node inside a workflow can call `invoke_workflow` on another workflow.

This keeps the architecture clean:
- Agents stay stateless (prompt + tools + trigger)
- Workflows are deterministic (graph execution, not LLM-driven)
- Tool policy controls which agents can call which workflows
- No new concepts needed — an agent already knows how to call a tool

---

## Agents Replace Users

In a Slack-style multi-agent system, human users and AI agents share the same channel membership model. Nessie does not support human user accounts — **agents fill this role**. Creating an agent is equivalent to "adding a team member."

Agents appear in:
- The sidebar (like users in Slack DMs/channels)
- @mention resolution
- Channel membership lists
- Tool execution audit trails (as the actor)

---

## 1. Agent Design Page

A dedicated page for creating and editing agents. This is the "Workflows" page in the Slack-style UI.

### Fields

| Field | Type | Notes |
|-------|------|-------|
| Name | text | Display name, used for @mention |
| Responsibility | textarea | One-paragraph description of what this agent does |
| System prompt | textarea | Full system prompt (overrides default) |
| Model | select | LLM model selection |
| Trigger | select + config | See trigger types below |
| Tools | checkbox list + search | Primitive tools + registered workflows |
| Parent agent | select | For hierarchy — defaults to root orchestrator |

### Trigger types

Each agent has exactly one trigger that determines when and how it activates:

| Type | Activated by | Config |
|------|-------------|--------|
| `on-demand` | @mention or direct message only | none |
| `scheduled` | Cron schedule | cron expression |
| `webhook` | Incoming HTTP POST + payload filter | path, optional auth token, payload filter expression |
| `event` | Named internal event | event name pattern (e.g. `task.review_passed`) |
| `message-pattern` | A channel message matching a keyword, regex, or @mention | channel ID, match pattern |
| `voice` | Voice command matching a phrase pattern | phrase pattern |
| `error` | Another named workflow or agent fails | source workflow/agent ID |
| `workflow-step` | Can only be called from within a workflow | none — no direct activation |

**Webhook + payload filter** covers all third-party integrations (GitHub, Jira, Stripe, Slack, etc.) without requiring dedicated per-service nodes. The payload filter narrows which events activate the workflow (e.g. only `action: "opened"` from GitHub PR webhooks).

**Error trigger** is critical for enterprise reliability — it enables "on failure, do X" patterns such as alerting, rollback, or escalation workflows.

---

## 2. Workflow Builder

A canvas-based page in the Slack-style UI. This is presented as a page within the agent creation/editing flow — after defining an agent, you can build a workflow and attach it as a tool.

### Layout

```
┌──────────┬───────────────────────────────────────┬───────────────┐
│ Toolbox  │              Canvas                    │  Properties   │
│          │                                        │  Panel        │
│ Trigger  │  [node] ──── [node] ──── [node]        │               │
│ Agent    │                  │                     │  (selected    │
│ Tool     │              [node]                    │   node        │
│ Router   │                  │                     │   config)     │
│ Fork     │              [node]                    │               │
│ Join     │                                        │               │
│ Project  │                                        │               │
│ Secret   │                                        │               │
└──────────┴───────────────────────────────────────┴───────────────┘
                      [Save]  [Run]  [Schedule]
```

### 9 Node Types

| # | Type | Canvas shape | Color | Purpose |
|---|------|-------------|-------|---------|
| 1 | **Trigger** | Rounded rect | Purple | Entry point — how the workflow starts |
| 2 | **Agent** | Rectangle | Blue | AI agent step — runs with a prompt and tools |
| 3 | **Tool** | Subroutine box | Teal | Direct tool invocation, no agent overhead |
| 4 | **Router** | Diamond | Amber | Branch — LLM evaluation or boolean condition |
| 5 | **Fork** | Circle | Green | Fan out to N parallel branches |
| 6 | **Join** | Circle | Green | Collect parallel results, resume single flow |
| 7 | **Human Input** | Hexagon | Orange | Pause execution, request input from a human (channel or DM) |
| 8 | **Project** | Cylinder | Slate | Scope injection — dashed "context" edge to agents/tools |
| 9 | **Secret** | Flag | Red | Named secret reference — dashed "inject" edge, resolved at runtime |

### Trigger node subtypes

A Trigger node has a subtype selected in the properties panel:

| Subtype | Activated by | Config |
|---------|-------------|--------|
| `manual` | UI "Run" button, `invoke_workflow` tool call, MCP direct call | none |
| `scheduled` | Cron expression | cron string |
| `webhook` | `POST /workflows/{id}/trigger` from any external system | payload filter expression |
| `event` | Named internal event (`task.review_passed`, `agent.wake`, etc.) | event name pattern |
| `message-pattern` | A channel message matching a keyword, regex, or @mention | channel ID, match pattern |
| `voice` | Voice command matching a phrase pattern | phrase pattern |
| `error` | A named workflow or agent fails | source workflow/agent ID |

**Day-one priority:** manual, webhook, schedule, event.
**Subsequent:** message-pattern, voice, error.
**Later:** file watch, email, calendar.

### Human Input node semantics

When the workflow engine reaches a Human Input node:

1. The workflow run transitions to `waiting_for_input` status — execution is **suspended**
2. A message is sent to the configured target:
   - **Channel**: broadcast to the channel, any human member can respond
   - **DM**: sent directly to a specific named user/agent — only their response unblocks it
3. The node holds a configurable `prompt` (what to ask) and `timeout` (how long to wait before failing)
4. When the human replies in chat, their message is attached to the workflow run and execution resumes from the Human Input node's output edge
5. The response is passed as `humanInput.text` to the next node

This integrates with the existing task approval model: a `waiting_for_input` workflow run creates a task in `awaiting_approval` state. The human response resolves that approval and resumes the run.

**Node properties:**
| Property | Type | Description |
|----------|------|-------------|
| `prompt` | text | What to ask the human |
| `target` | `channel \| dm` | Where to send the request |
| `targetId` | string | Channel ID or agent/user ID |
| `timeout` | duration | How long to wait (default: no timeout) |
| `timeoutAction` | `fail \| skip \| default` | What to do on timeout |
| `defaultValue` | text | Used when `timeoutAction` is `default` |

### Project node semantics

- Represents a filesystem scope for the agents/tools it connects to
- Properties: `rootPath`, `allowedPaths[]`, `gitBranch`, optional `claudeMdPath`
- Connected via dashed "context" edge — does not block execution flow
- Restricts the connected node's file access and injects CLAUDE.md as system context
- A workflow-level default project can be set in the workflow header (applies to all nodes unless overridden by a local Project node)

### Secret node semantics

- A reference to a named secret in the vault — never stores the actual value
- Properties: `name`, `vaultKey`, `injectAs` (env var name injected at runtime)
- Connected via dashed "inject" edge — does not block execution flow
- Value is resolved at runtime only; the workflow definition stores only the vault key name
- Workflow-level secrets can be bound in the header panel for global injection across all nodes

---

## 3. Evals — Agent Node, Not a New Type

Eval steps do not require a dedicated node type. An eval is mechanically identical to an Agent node — it is an LLM call with a structured verification prompt that outputs a pass/fail result. Adding a separate node type would duplicate the Agent node with no additional capability.

The correct pattern is:

```
[previous output] → [Eval Agent node] → [Router: passed?] → yes → [continue]
                                                           → no  → [repair / retry / fail]
```

The Agent node outputs `{ passed: boolean, score: number, reasoning: string, issues: string[] }` and the Router evaluates `passed`.

**Eval preset in the toolbox:** Rather than a new node type, the toolbox includes an **Eval** preset — an Agent node pre-configured with a structured eval system prompt, auto-connected to a Router with `passed / failed` branches. Dragging this preset onto the canvas places both nodes and wires them in one action.

This keeps the node type count clean and avoids a redundant abstraction. The distinction between an eval agent and any other agent is entirely in the system prompt.

---

## 4. Workflow as a Tool — Registration

When a workflow is saved:

1. A record is written to the `workflows` table (id, name, description, graph JSON)
2. The workflow is auto-registered in the tool catalog as an `invoke_workflow` target
3. Agents can be granted access to specific workflow IDs via the tool policy checkbox UI
4. The workflow appears in the tool search/checkbox list on the agent design page

### DB schema additions

```sql
CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  graph_json TEXT NOT NULL,  -- { nodes: [...], edges: [...] }
  trigger_type TEXT NOT NULL DEFAULT 'manual',
  trigger_config TEXT,       -- JSON: cron expression, webhook path, event pattern, etc.
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  task_id TEXT REFERENCES tasks(id),
  status TEXT NOT NULL,  -- pending, running, done, failed
  inputs TEXT,           -- JSON
  outputs TEXT,          -- JSON
  error TEXT,
  started_at INTEGER,
  finished_at INTEGER
);
```

### `invoke_workflow` tool

```typescript
// Registered in tool catalog alongside Bash, FileRead, etc.
{
  name: 'invoke_workflow',
  description: 'Execute a registered workflow by ID and return its result',
  inputSchema: z.object({
    workflowId: z.string(),
    inputs: z.record(z.unknown()).optional(),
  }),
  call: async ({ workflowId, inputs }) => {
    // Resolve workflow from DB
    // Create workflow_run record
    // Execute node graph via WorkflowEngine
    // Return { output, runId, status, durationMs }
  }
}
```

---

## 4. New MCP tools

| Tool | Description |
|------|-------------|
| `invoke_workflow` | Execute a workflow by ID, returns result |
| `create_workflow` | Save a new workflow definition (graph JSON) |
| `update_workflow` | Update an existing workflow |
| `delete_workflow` | Delete a workflow |
| `list_workflows` | List all registered workflows |
| `get_workflow_run` | Get the status and output of a workflow run |
| `list_workflow_runs` | List runs for a given workflow |

---

## 5. Parity additions

Entries to add to the control-plane parity matrix in [functionality.md](../functionality.md):

| Capability | HTTP | MCP action | Chat | Status |
|-----------|------|-----------|------|--------|
| workflow CRUD | `GET/POST/PATCH/DELETE /workflows` | `workflow.create`, `workflow.update`, `workflow.delete`, `workflow.list` | `/workflow create` | blocked |
| workflow execution | `POST /workflows/{id}/trigger` | `invoke_workflow` | `/workflow run <id>` | blocked |
| workflow run status | `GET /workflows/{id}/runs/{runId}` | `get_workflow_run` | N/A | blocked |
| agent design CRUD | `GET/POST/PATCH/DELETE /agents` | `agent.create`, `agent.update`, `agent.delete`, `agent.list` | `/agent create` | blocked |

---

## 6. Implementation order

1. DB schema — `workflows` and `workflow_runs` tables
2. `invoke_workflow` tool — registered alongside Bash, FileRead, etc. in `src/tools/`
3. `WorkflowEngine` — sequential node graph executor (`src/workflow/engine.ts`)
4. Fork/Join support in engine — parallel branch execution and result collection
5. Trigger types — webhook endpoint, cron scheduler, event listener
6. REST routes — `GET/POST/PATCH/DELETE /workflows`, `POST /workflows/{id}/trigger`
7. MCP tools — `invoke_workflow`, `create_workflow`, `list_workflows`, etc.
8. Agent design page — UI with tool checkbox list (includes workflows), trigger config
9. Workflow builder canvas — toolbox, 8 node types, properties panel, drag-and-drop
10. Project/Secret node resolution — connect to vault and filesystem scope at runtime

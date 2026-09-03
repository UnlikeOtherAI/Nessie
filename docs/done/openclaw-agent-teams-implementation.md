# Implementing Multi-Agent Orchestration for Nessie

> **Status**: partially superseded implementation plan. Use [functionality.md](./functionality.md) for current runtime state and [agent-communication-spec.md](./agent-communication-spec.md) plus [organization-governance-spec.md](./organization-governance-spec.md) for active target-state design.

## Goal

Build a verifiable, OpenClaw-compatible multi-agent orchestration layer for
Nessie that:

- keeps the current Nessie app and runtime usable during migration
- makes task delegation explicit and durable
- treats verification as a required state transition
- adds bounded spawning, approvals, and auditability
- stays compatible with eventual OpenClaw integration without requiring a full
  OpenClaw rewrite on day one

## Non-Goals

This implementation plan does not assume:

- replacing Nessie’s runtime with Pi immediately
- embedding OpenClaw Control UI
- adopting ClawHub or a public skill marketplace
- reproducing every OpenClaw subsystem before shipping value

The target is operational parity for team orchestration patterns, not a clone of
the entire OpenClaw platform.

## Current Repo Baseline

What Nessie already has:

- `src/agent/Orchestrator.ts`
  One central coordinator with basic sub-agent concepts.
- `src/agent/types.ts`
  Agent and sub-agent state types.
- `src/events.ts`
  Event bus model for state, streaming, sub-agent, and tool events.
- `src/db/database.ts`
  SQLite-backed persistence for messages and diary entries.
- `src/index.ts`
  HTTP and WS server entrypoint.
- `src/tools/*`
  A tool abstraction and concrete local tools.
- `macos/Nessie/App.swift`
  Client-side state reduction and UI state assembly.

What Nessie does not have yet:

- a durable task ledger
- explicit task lifecycle states
- bounded spawn contracts
- explicit review and adjudication states
- role-specific tool policy
- approvals for high-risk side effects
- event-driven sub-agent completion semantics comparable to OpenClaw announce
- evals for multi-agent team quality

## Target Architecture

## Control plane

Nessie keeps a deterministic orchestration runtime in the server process.

That runtime owns:

- task creation
- task state transitions
- spawn budgets
- retries and timeouts
- idempotency for task-side effects
- audit logging
- verification gating

## Agents and roles

We standardise around four primary roles:

- Orchestrator
  Owns decomposition, routing, aggregation, and final acceptance.
- Builder
  Produces artefacts.
- Reviewer
  Validates outputs against spec and evidence.
- Ops or Watcher
  Monitors stalls, loop behaviour, cost, and runtime anomalies.

Specialist roles are spawned only when needed:

- Researcher
- Debugger
- Adjudicator
- Policy Guard

## Session model

We adopt an explicit parent and child session graph:

- main session
- task sessions
- child worker sessions

Every spawned run must have:

- a task ID
- a parent session ID
- a role
- an output path
- a timeout
- an expected completion contract

## Artefact model

No meaningful task should complete with "just chat text."

Each task must produce:

- a structured handoff
- explicit artefact paths
- verification instructions
- residual risks or blockers

## Proposed Runtime Components

### `src/orchestration/task-ledger.ts`

Purpose:

- durable task records
- state transitions
- parent and child linkage
- assigned role
- timeout and retry metadata
- approval state

Backed by SQLite alongside the existing message store.

### `src/orchestration/task-types.ts`

Purpose:

- task types
- task lifecycle enums
- handoff schemas
- verification result types
- spawn request and spawn result types

This becomes the typed contract for orchestration.

### `src/orchestration/role-registry.ts`

Purpose:

- role definitions
- allowed tools per role
- default model choice per role
- allowed child roles
- sandbox and approval requirements

This is where "one agent, one primary responsibility" is encoded.

### `src/orchestration/spawn-manager.ts`

Purpose:

- create child task sessions
- enforce max depth
- enforce max children
- enforce concurrency caps
- enforce timeouts
- route completion back to the parent

This should mirror OpenClaw’s non-blocking spawn plus structured completion
semantics.

### `src/orchestration/announce.ts`

Purpose:

- turn child completion into a structured runtime event
- include runtime-derived status
- include stats
- include artefact references

This replaces ad hoc child result strings with a real completion protocol.

### `src/orchestration/verification.ts`

Purpose:

- review gate logic
- repair loop orchestration
- second-reviewer spawning
- adjudication path
- external check integration

This is the core of "verification as a state."

### `src/orchestration/approvals.ts`

Purpose:

- approval requests for high-risk side effects
- resume or reject flows
- idempotent execution after approval

This is the Nessie equivalent of the useful Lobster pattern, even if we do not
adopt Lobster itself immediately.

### `src/orchestration/metrics.ts`

Purpose:

- capture token and runtime stats where available
- count tools and failures
- track repair depth
- track disagreement rate
- surface loop-detection events

## Task Lifecycle

Every non-trivial orchestration task should move through explicit states:

1. Inbox
2. Assigned
3. In Progress
4. Review
5. Done
6. Failed
7. Cancelled
8. Awaiting Approval

Rules:

- only the orchestrator moves a task into `Assigned`
- workers move tasks toward `In Progress`
- reviewers can move tasks back to `In Progress` or to `Done`
- high-risk side effects cannot move to `Done` until approval is satisfied

## Spawn Semantics

We should implement spawn to behave like this:

- parent requests child spawn
- runtime validates policy and budgets
- child session is created immediately
- parent gets accepted status plus child task ID
- parent does not poll in a loop
- child completion returns via a runtime event and persisted ledger entry

Required spawn fields:

- `taskId`
- `parentTaskId`
- `role`
- `label`
- `outputPath`
- `timeoutSeconds`
- `maxDepth`
- `toolScope`
- `modelOverride`

## Verification Strategy

Default rule:

- no non-trivial task completes without review

Verification order:

1. external truth checks when available
2. reviewer pass
3. repair iteration
4. second reviewer if needed
5. adjudication
6. human escalation for unresolved cases

External truth checks should include:

- tests
- compilation
- lint
- schema validation
- reproducible command output
- retrieval-backed claim checking where appropriate

We should not use debate as the default verification mechanism. Majority vote or
independent second review is cheaper and usually more defensible.

## Tool Policy and Capability Boundaries

We should move from one shared tool surface toward role-scoped tool policies.

Initial policy:

- Orchestrator
  Read-only plus spawn and ledger control. No destructive tools by default.
- Builder
  Read and write tools needed for the task.
- Reviewer
  Read-only tools and validation tools. No mutation.
- Ops or Watcher
  Read-only operational tools and metrics access.

High-risk actions should require:

- explicit approval
- logged reason
- resumable continuation after approval

## OpenClaw Compatibility Strategy

We should design this layer so it can later interoperate with OpenClaw in any of
three ways already explored in this repo:

- Nessie as an OpenClaw operator client
- Nessie as an OpenClaw node
- hybrid deployment where OpenClaw owns channels and Nessie provides local
  capability surfaces

That means our orchestration contracts should already look OpenClaw-compatible:

- explicit session IDs
- typed events
- non-blocking spawn plus completion announce
- bounded visibility
- role-specific tool policy
- durable task state

We should not wait for full OpenClaw integration before implementing those
patterns locally.

## Prompt and Team Design

We should standardise prompt layers:

- team `AGENTS.md`
  Team operating rules, artefact conventions, review requirements, escalation
  policy
- role charters
  One stable mission and boundary set per role
- task prompt
  Inputs, constraints, output path, verification contract

We should keep:

- stable rules in versioned files
- task specifics in task prompts
- results in durable artefacts

We should avoid:

- putting runtime policy only in prompts
- letting workers infer where outputs belong
- using free-form completion text as the only return channel

## UI and Client Changes

The macOS client should surface orchestration state explicitly.

Needed UI behaviours:

- active task list with task state
- child task tree
- review-required badge
- approval-required badge
- tool activity by task
- disagreement or failure indicators

The event bus already exists. It needs new event types for:

- `task.created`
- `task.state_changed`
- `task.spawned`
- `task.announced`
- `task.review_failed`
- `task.awaiting_approval`
- `task.approved`
- `task.failed`

## Data Model Changes

Add new durable tables:

- `tasks`
- `task_events`
- `task_artifacts`
- `task_reviews`
- `task_approvals`

Minimum `tasks` fields:

- `id`
- `parent_id`
- `thread_id`
- `role`
- `label`
- `status`
- `spec_path`
- `output_path`
- `assigned_model`
- `timeout_seconds`
- `created_at`
- `updated_at`
- `completed_at`

## Metrics and Evals

We should capture:

- task completion rate
- task failure rate
- reviewer rejection rate
- repair depth
- disagreement rate
- timeout rate
- tool error rate
- loop-detection warnings
- token and runtime cost per role

We should add a small eval harness for:

- code change tasks
- research tasks
- file-mutation tasks
- reviewer consistency
- approval and rejection flows

## Phased Implementation Plan

### Phase 1: Task ledger and explicit states

Build:

- task tables
- task state transitions
- state-change events

Acceptance:

- every non-trivial orchestration action produces a durable task record
- UI can render task state history

### Phase 2: Structured spawn and announce

Build:

- spawn manager
- child task sessions
- announce event path
- timeouts and concurrency caps

Acceptance:

- child runs are non-blocking
- parent receives structured completion events
- no polling loops are needed

### Phase 3: Reviewer role and verification gate

Build:

- role registry
- read-only reviewer tool scope
- review pass and rejection flow

Acceptance:

- tasks cannot reach `Done` without a review result
- reviewer can reject and force a repair cycle

### Phase 4: External checks and approvals

Build:

- validator adapters
- approval state
- resume after approval

Acceptance:

- high-risk actions pause for approval
- approved resumptions are idempotent

### Phase 5: Metrics and watcher role

Build:

- metrics capture
- watcher role
- stale-task and loop alerts

Acceptance:

- orchestrator health and failure signals are visible in UI and logs

### Phase 6: OpenClaw interop layer

Build:

- mapping from local task events to OpenClaw-compatible session events
- optional operator or node bridge

Acceptance:

- core orchestration remains local and deterministic
- OpenClaw integration becomes an adapter, not a rewrite

## Recommended First Slice

The first slice should be:

- task ledger
- task states
- structured spawn
- announce events
- reviewer gate

That is the smallest useful change set that moves Nessie from "single
orchestrator with informal sub-agents" to "real verifiable multi-agent
orchestration."

## Decision Summary

We should implement multi-agent orchestration in Nessie as:

- a deterministic server-side control plane
- explicit role definitions
- durable task state
- bounded child spawning
- structured completion announcements
- mandatory review gates
- approval gates for high-risk actions
- OpenClaw-compatible event and session semantics where useful

We should not:

- wait for a full OpenClaw integration before doing the architecture cleanup
- rely on prompts alone for policy
- let worker outputs remain chat-only and non-auditable
- treat verification as optional

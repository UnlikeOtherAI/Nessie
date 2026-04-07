# Multi-Agent Orchestration Implementation Plan

> **Status**: historical implementation plan.

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a verifiable, durable multi-agent orchestration layer for Nessie with task ledger, structured spawn, review gates, approvals, metrics, and OpenClaw-compatible events.

**Architecture:** Server-side deterministic control plane in `src/orchestration/`. SQLite-backed task ledger alongside existing message store. Event-driven completion (no polling). Role-scoped tool policies enforced at runtime. macOS app surfaces all orchestration state via existing WebSocket event bus.

**Tech Stack:** TypeScript (bun), SQLite (bun:sqlite), Zod schemas, SwiftUI (macOS 14+), MCP JSON-RPC 2.0

---

## Verification Protocol (applies to EVERY phase)

Each phase has a **Verification Gate** section with mandatory checkboxes. A phase is NOT complete until ALL boxes are checked:

1. **App Reveal** -- Launch the macOS app, use App Reveal to inspect the view hierarchy, click through every new UI element, type messages that exercise the new backend features, confirm state updates render correctly.
2. **MCP Protocol** -- Use the MCP endpoint (`POST /mcp` with JSON-RPC) to exercise every new capability. Confirm correct responses, error handling, and event broadcasting.
3. **Codex Review** -- Run `timeout 1800 codex exec "<review prompt>"` for aggressive adversarial code review. Fix all findings before moving on.

---

## Phase 1: Task Ledger and Explicit States

**Goal:** Every non-trivial orchestration action produces a durable task record with explicit lifecycle states. UI renders task state.

### Task 1.1: Define task types

**Files:**
- Create: `src/orchestration/task-types.ts`

**Step 1: Write task-types.ts**

Define:
- `TaskStatus` enum: inbox, assigned, in_progress, review, done, failed, cancelled, awaiting_approval
- `TaskRole` enum: orchestrator, builder, reviewer, watcher, researcher, debugger
- `Task` interface with all fields (id, parentId, threadId, role, label, status, specPath, outputPath, assignedModel, timeoutSeconds, timestamps)
- `TaskEvent` interface (id, taskId, fromStatus, toStatus, reason, timestamp)
- `TaskArtifact` interface (id, taskId, path, mimeType, createdAt)
- `CreateTaskSchema` Zod schema for validation
- `VALID_TRANSITIONS` map defining allowed state transitions

**Step 2: Commit**

```bash
git add src/orchestration/task-types.ts
git commit -m "feat(orchestration): add task type definitions and lifecycle states"
```

### Task 1.2: Create task ledger with SQLite persistence

**Files:**
- Create: `src/orchestration/task-ledger.ts`
- Modify: `src/db/database.ts` (add task tables)

**Step 1: Add task tables to database.ts**

Add `tasks`, `task_events`, `task_artifacts` tables with indexes.

**Step 2: Write task-ledger.ts**

TaskLedger class with:
- `createTask(input)` -- inserts task + records creation event
- `transition(taskId, toStatus, reason)` -- validates transition, updates, records event
- `getTask(taskId)` -- single task lookup
- `getTasksByStatus(status)` -- filtered list
- `getChildTasks(parentId)` -- child task lookup
- `getAllTasks(limit)` -- paginated list
- `getTaskEvents(taskId)` -- event history
- `addArtifact(taskId, path, mimeType)` -- attach artifact
- `getArtifacts(taskId)` -- artifact list

**Step 3: Commit**

```bash
git add src/orchestration/task-ledger.ts src/db/database.ts
git commit -m "feat(orchestration): add task ledger with SQLite persistence"
```

### Task 1.3: Add task events to event bus

**Files:**
- Modify: `src/events.ts` (add task event types)

**Step 1: Add to ServerEvent union and new interfaces**

- `ServerEventTaskCreated` with `type: 'task.created'` and `TaskSummary`
- `ServerEventTaskStateChanged` with `type: 'task.state_changed'`, taskId, fromStatus, toStatus, reason
- `TaskSummary` interface (id, parentId, role, label, status, createdAt, updatedAt)

**Step 2: Commit**

```bash
git add src/events.ts
git commit -m "feat(events): add task.created and task.state_changed event types"
```

### Task 1.4: Wire task ledger into orchestrator

**Files:**
- Modify: `src/agent/Orchestrator.ts`

**Step 1: Add TaskLedger to constructor, wire into sub-agent flow**

- Instantiate `TaskLedger` in constructor
- `handleSubAgentTask` creates a task record, transitions through lifecycle
- Broadcast `task.created` and `task.state_changed` events via onBroadcast

**Step 2: Expose task operations**

Add public methods: `getTasks()`, `getTask(id)`, `getTaskEvents(id)`, `createTask(input)`, `transitionTask(id, status, reason)`

**Step 3: Commit**

```bash
git add src/agent/Orchestrator.ts
git commit -m "feat(orchestrator): wire task ledger with event broadcasting"
```

### Task 1.5: Add MCP tools for task management

**Files:**
- Modify: `src/mcp/server.ts` (add tool definitions)
- Modify: `src/mcp/adapter.ts` (expose task operations)

**Step 1: Add MCP tools: `create_task`, `list_tasks`, `get_task`, `transition_task`**

**Step 2: Wire adapter to orchestrator task methods**

**Step 3: Commit**

```bash
git add src/mcp/server.ts src/mcp/adapter.ts
git commit -m "feat(mcp): expose task ledger as MCP tools"
```

### Task 1.6: Add task events to SSE and WebSocket broadcast

**Files:**
- Modify: `src/index.ts`

**Step 1: Map `task.created` and `task.state_changed` through SSE emit switch**

**Step 2: Commit**

```bash
git add src/index.ts
git commit -m "feat(server): broadcast task events via SSE and WebSocket"
```

### Task 1.7: macOS app -- add task model and state

**Files:**
- Modify: `macos/Nessie/Models.swift` (add TaskItem model)
- Modify: `macos/Nessie/App.swift` (add tasks to AppState, handle events)

**Step 1: Add TaskItem struct (id, parentId, role, label, status, createdAt, updatedAt)**

**Step 2: Add `@Published var tasks: [TaskItem]` to AppState, handle `task.created` and `task.state_changed` WebSocket events**

**Step 3: Commit**

```bash
git add macos/Nessie/Models.swift macos/Nessie/App.swift
git commit -m "feat(macos): add task model and state handling for task events"
```

### Task 1.8: macOS app -- render task list in StatusPanel

**Files:**
- Modify: `macos/Nessie/StatusPanel.swift`

**Step 1: Add TASKS section above SUB-AGENTS showing label, role badge, status badge (color-coded), parent linkage, timestamps**

**Step 2: Commit**

```bash
git add macos/Nessie/StatusPanel.swift
git commit -m "feat(macos): render task list in status panel"
```

### Phase 1 Verification Gate

- [ ] **App Reveal -- Task list renders:** Launch app, open Status Panel, create a task via MCP, confirm it appears in TASKS section with correct label/role/status.
- [ ] **App Reveal -- State transitions render:** Transition the task through statuses via MCP, confirm status badge updates in real-time via WebSocket.
- [ ] **App Reveal -- Task tree:** Create parent and child tasks, confirm parent-child relationship visible.
- [ ] **MCP -- create_task:** `POST /mcp` with `tools/call` -> `create_task` returns task with status `inbox`.
- [ ] **MCP -- list_tasks:** Returns all tasks. Filter by status returns correct subset.
- [ ] **MCP -- get_task:** Returns task details + full event history.
- [ ] **MCP -- transition_task:** Moves task through `inbox` -> `assigned` -> `in_progress` -> `review` -> `done`. Invalid transitions return errors.
- [ ] **MCP -- Invalid transition rejected:** Attempting `inbox` -> `done` returns error.
- [ ] **Chat integration:** Sending a message that triggers a sub-agent creates a task record automatically.
- [ ] **Codex review:** Adversarial review of all Phase 1 files. All findings fixed.

---

## Phase 2: Structured Spawn and Announce

**Goal:** Child runs are non-blocking. Parent receives structured completion events. No polling loops.

### Task 2.1: Create spawn manager

**Files:**
- Create: `src/orchestration/spawn-manager.ts`

SpawnManager responsibilities:
- Create child task sessions with bounded depth (`maxSpawnDepth: 3`)
- Enforce `maxChildrenPerAgent` (default 5)
- Enforce `maxConcurrent` (default 3)
- Track active spawns
- Timeout management via `setTimeout` with cleanup
- Non-blocking spawn returns immediately with task ID
- Completion routes back to parent via event

Key types: `SpawnRequest` (parentTaskId, role, label, toolScope, timeoutSeconds, modelOverride) and `SpawnResult` (taskId, accepted, reason).

**Step 1: Commit**

### Task 2.2: Create announce system

**Files:**
- Create: `src/orchestration/announce.ts`
- Modify: `src/events.ts` (add `task.spawned`, `task.announced`)

Announce turns child completion into structured runtime events:
- Status from runtime state (not model self-report)
- Includes duration, tool call count
- Includes artifact references
- Pushes to parent's thread

**Step 1: Commit**

### Task 2.3: Refactor Orchestrator sub-agent handling to use SpawnManager

**Files:**
- Modify: `src/agent/Orchestrator.ts`

Replace `handleSubAgentTask` internals with SpawnManager:
- Calls `spawnManager.spawn(request)`
- SpawnManager creates task, enforces limits, runs child
- On completion, announce system fires `task.announced`
- Parent thread receives structured result

**Step 1: Commit**

### Task 2.4: Add spawn/announce MCP tools

**Files:**
- Modify: `src/mcp/server.ts`
- Modify: `src/mcp/adapter.ts`

New tools: `spawn_task`, `get_spawn_status`

**Step 1: Commit**

### Task 2.5: macOS app -- render spawn tree and announcements

**Files:**
- Modify: `macos/Nessie/StatusPanel.swift`
- Modify: `macos/Nessie/App.swift`

Show: active spawns with progress, spawn depth tree (indented), announce events with duration/status/result.

**Step 1: Commit**

### Phase 2 Verification Gate

- [ ] **App Reveal -- Spawn tree renders:** Trigger multi-step task, child tasks appear indented under parent.
- [ ] **App Reveal -- Announce event shows:** Child completion shows duration and result.
- [ ] **App Reveal -- Concurrent spawn limit:** Spawn 4+ tasks, only 3 run concurrently.
- [ ] **MCP -- spawn_task:** Returns `{ taskId, accepted: true }`.
- [ ] **MCP -- spawn rejection:** Exceed depth, get `{ accepted: false, reason }`.
- [ ] **MCP -- get_spawn_status:** Returns active/queued counts.
- [ ] **MCP -- Timeout enforcement:** Task fails after timeout.
- [ ] **Event stream -- task.spawned and task.announced fire correctly.**
- [ ] **No polling loops in codebase.**
- [ ] **Codex review:** Adversarial review of spawn/announce. All findings fixed.

---

## Phase 3: Reviewer Role and Verification Gate

**Goal:** Tasks cannot reach `done` without review. Reviewer can reject and force repair.

### Task 3.1: Create role registry

**Files:**
- Create: `src/orchestration/role-registry.ts`

Roles with tool policies:
- Orchestrator: read-only + spawn + ledger
- Builder: read + write tools
- Reviewer: read-only + validation
- Watcher: read-only + metrics

### Task 3.2: Create verification gate

**Files:**
- Create: `src/orchestration/verification.ts`
- Modify: `src/events.ts` (add `task.review_passed`, `task.review_failed`)

Review flow: task enters `review` -> spawn reviewer -> PASS moves to `done`, FAIL moves back to `in_progress` with repair instructions. Max 3 repair iterations.

### Task 3.3: Enforce review gate in transitions

**Files:**
- Modify: `src/orchestration/task-ledger.ts`

Guard: non-orchestrator tasks cannot skip `review` to reach `done`.

### Task 3.4: Add review MCP tools

`submit_review`, `get_review_history`, `list_roles`

### Task 3.5: macOS app -- render review state

Review badges, pass/fail results, repair count, escalation warning.

### Phase 3 Verification Gate

- [ ] **App Reveal -- Review badge on tasks in review status.**
- [ ] **App Reveal -- Pass/fail result inline.**
- [ ] **App Reveal -- Repair iteration count visible.**
- [ ] **MCP -- submit_review PASS transitions to done.**
- [ ] **MCP -- submit_review FAIL transitions back to in_progress.**
- [ ] **MCP -- Review gate enforced (in_progress -> done blocked).**
- [ ] **MCP -- list_roles returns tool policies.**
- [ ] **MCP -- get_review_history returns chronological results.**
- [ ] **Tool scoping: reviewer cannot write files.**
- [ ] **Max repair escalation after 3 failures.**
- [ ] **Codex review:** Adversarial review of role/verification. All findings fixed.

---

## Phase 4: External Checks and Approvals

**Goal:** High-risk actions pause for approval. External validators integrated.

### Task 4.1: Create approvals system

**Files:**
- Create: `src/orchestration/approvals.ts`
- Modify: `src/events.ts`

Flow: `awaiting_approval` with reason -> approve resumes -> reject cancels. Idempotent re-approval.

### Task 4.2: Create validator adapters

**Files:**
- Create: `src/orchestration/validators.ts`

Validator interface with `run(taskId, artifactPaths)`. Built-in: TestValidator, LintValidator, TypeCheckValidator. Uses `execFile` (not `exec`) for all subprocess calls.

### Task 4.3: Wire validators into verification gate

Run external validators before spawning reviewer. Validator failure skips review and returns to `in_progress`.

### Task 4.4: Add approval MCP tools

`request_approval`, `approve_task`, `reject_task`, `list_pending_approvals`, `run_validators`

### Task 4.5: macOS app -- render approval state

Amber badges, reason text, approve/reject buttons, validator results.

### Phase 4 Verification Gate

- [ ] **App Reveal -- Approval badge renders (amber).**
- [ ] **App Reveal -- Approve button resumes task.**
- [ ] **App Reveal -- Reject button cancels task.**
- [ ] **App Reveal -- Validator results show inline.**
- [ ] **MCP -- request_approval moves to awaiting_approval.**
- [ ] **MCP -- approve_task resumes. Idempotent.**
- [ ] **MCP -- reject_task cancels.**
- [ ] **MCP -- list_pending_approvals returns correct set.**
- [ ] **MCP -- run_validators runs lint + typecheck.**
- [ ] **Codex review:** Adversarial review of approvals/validators. All findings fixed.

---

## Phase 5: Metrics and Watcher Role

**Goal:** Health and failure signals visible. Stale task detection. Loop alerts.

### Task 5.1: Create metrics capture

**Files:**
- Create: `src/orchestration/metrics.ts`
- Modify: `src/db/database.ts`

Per-task: duration, tool count, review count, repair depth, timeout. Aggregate: tasks by status, completion rate, failure rate, average repair depth.

### Task 5.2: Create watcher role

**Files:**
- Create: `src/orchestration/watcher.ts`
- Modify: `src/events.ts` (add `watcher.alert`)

Runs on 60s interval. Detects: stale tasks (>5min no change), loops (same state toggle), runaway spawns.

### Task 5.3: Add metrics MCP tools

`get_metrics`, `get_task_metrics`, `get_alerts`

### Task 5.4: macOS app -- render metrics and alerts

Metrics summary, alert banner, per-task duration/repair depth.

### Phase 5 Verification Gate

- [ ] **App Reveal -- Metrics section in Status Panel.**
- [ ] **App Reveal -- Alert banner on stale task.**
- [ ] **App Reveal -- Per-task metrics visible.**
- [ ] **MCP -- get_metrics returns accurate aggregates.**
- [ ] **MCP -- get_task_metrics returns per-task data.**
- [ ] **MCP -- get_alerts returns stale/loop alerts.**
- [ ] **Loop detection fires on repeated state toggles.**
- [ ] **Watcher runs automatically on interval.**
- [ ] **Codex review:** Adversarial review of metrics/watcher. All findings fixed.

---

## Phase 6: OpenClaw Interop Layer

**Goal:** Local orchestration stays deterministic. OpenClaw integration as adapter.

### Task 6.1: Create OpenClaw event mapper

**Files:**
- Create: `src/orchestration/openclaw-bridge.ts`

Maps local events to OpenClaw-compatible format. No OpenClaw dependency -- format compatibility only.

### Task 6.2: Session export/import

Export task tree as OpenClaw session. Import OpenClaw session into local ledger.

### Task 6.3: Add interop MCP tools

`export_openclaw_session`, `import_openclaw_session`

### Task 6.4: macOS app -- OpenClaw status indicator

Compatibility badge, export button.

### Phase 6 Verification Gate

- [ ] **App Reveal -- OpenClaw badge renders.**
- [ ] **MCP -- export_openclaw_session matches schema.**
- [ ] **MCP -- import_openclaw_session creates local tasks.**
- [ ] **Round-trip: export -> import -> export produces identical output.**
- [ ] **All Phase 1-5 functionality still works.**
- [ ] **Codex review:** Adversarial review of bridge. All findings fixed.

---

## Execution Order

Phases are strictly sequential. Each builds on the previous.

1. Phase 1 -- Task ledger and explicit states (foundation)
2. Phase 2 -- Structured spawn and announce (requires ledger)
3. Phase 3 -- Reviewer role and verification gate (requires spawn)
4. Phase 4 -- External checks and approvals (requires verification)
5. Phase 5 -- Metrics and watcher role (requires all prior)
6. Phase 6 -- OpenClaw interop layer (adapter over everything)

# Nessie Functionality Map (Source-of-Truth)

> Status: active implementation reference plus target-state control-plane map.

As of `2026-04-07`, this document captures all implemented runtime behavior in the Node backend and control-plane code that the future authenticated Nessie interface should mirror, then consume via mocks.

Interpretation rule:
- the root app layout and phase-roadmap cross-links at the top of this file are target-state guidance,
- the route and runtime sections below still describe the current legacy `src/index.ts` server unless a section explicitly says otherwise.
- legacy runtime capabilities such as host `Bash`, `FileWrite`, and other privileged local tools must not be treated as Phase 1 MVP requirements for the new `/api` + `/admin` architecture.
- new Phase 1 backend endpoints for the rebuilt product should be rooted under `/api/...` as defined in [implementation-phases.md](./implementation-phases.md).

The checkbox-based tool policy model is documented as a separate target-state design in [agent tool capabilities](./agent%20tool%20capabilities/index.md), and is currently not fully enforced at runtime.

## 1) Interface contracts

`UI/admin/tag.md`:

- `tag: nessie-ui-admin-v1`
- `label: Nessie admin and product interface`
- `scope: admin`
- `status: planning`
- `contract_version: 1.0.0`

`UI/web/tag.md`:

- `tag: nessie-ui-web-v1`
- `label: Nessie web landing page`
- `scope: web`
- `status: planning`
- `contract_version: 1.0.0`

Use `tag` as the canonical identifier for mock stories, tests, and integration points.

Roadmap cross-link:
- [implementation-phases.md](./implementation-phases.md)

Root app layout:
- `/api` = backend/control-plane service
- `/admin` = full Nessie product interface
- `/web` = landing page only
- `/worker` = async execution service

## 2) Process startup and runtime surface

### 2.1 Server bootstrap (`src/index.ts`)

- Initializes LLM client via `createLlmClient()` (OpenAI default, MiniMax optional via `LLM_PROVIDER=minimax`).
- Creates orchestrator with callbacks:
  - `onBroadcast`: forwards every server event to WS + SSE sinks
  - `onStateChange`: logs state summary only; no state snapshot is emitted from this callback.
- Creates MCP server + adapter.
- Advertises mDNS service `_nessie._tcp` on configured port.
- Registers the HTTP server routes and WebSocket server on the same listener.
- Connects OpenAI Realtime client only when `OPENAI_API_KEY` is present.
- Installs `SIGINT` and `SIGTERM` shutdown handlers:
  - close all WS clients
  - clear in-memory SSE stream map
  - stop mDNS
- Calls `orchestrator.close()` during shutdown (clears intervals, spawn timers, watcher).

## 3) Configuration map (`process.env`)

- `LLM_PROVIDER`: `openai` (default) or `minimax`.
- `OPENAI_API_KEY` / `OPENAI_CHAT_API_KEY`: OpenAI chat/stream keys and Realtime credential.
- `MINIMAX_API_KEY`: MiniMax API key.
- `HELPER_HOST`: HTTP/WS bind host (default `127.0.0.1`).
- `HELPER_PORT` or `PORT`: HTTP/WS bind port (default `4317`).
- `HELPER_DB_PATH`: SQLite path (default `${HOME}/.helper/agent.db`).
- `HELPER_WEATHER_QUERY`: optional weather city/path for weather agent updates.

## 4) HTTP routes (`src/index.ts`)

### 4.1 `GET /health`

Returns:
- `ok: true`
- `llmConfigured: boolean` — whether LLM client was successfully created.

### 4.2 `GET /state`

Returns orchestrator state (`orchestrator.getState()`), currently:
- agents, messages, sub-agents, listening/speaking flags, and tasks (ledger-derived).

### 4.3 `DELETE /history[?threadId=...]`

- `threadId` absent: removes all messages + diary rows.
- `threadId` provided: removes only that thread’s messages and diary.
- Emits `state` broadcast after deletion.
- Response: `{ deleted: <n>, threadId }`.

### 4.4 `POST /chat` (SSE stream)

This section describes the current legacy runtime behavior only.

New `/api` and `/admin` work must use the canonical dotted realtime event catalog in [shared-type-contracts-spec.md](./shared-type-contracts-spec.md).

- Reads JSON body fields:
  - `message` (required)
  - `threadId` (optional; defaults to `main`)
- Route matching is permissive (`/chat` plus prefix), so `/chat/sync` is handled by this SSE path.
- Malformed JSON in the body is unguarded and can throw before validation.
- Rejects empty message with `400 { error: "message is required" }`.
- Starts SSE stream with headers:
  - `text/event-stream`
  - `Cache-Control: no-cache`
  - `Connection: keep-alive`
  - `X-Accel-Buffering: no`
- Registers the stream in `sseStreams` and maps internal events to SSE types:
  - `streaming.start` → `start` (includes `runId`, `threadId`)
  - `streaming.delta` → `delta`
  - `streaming.done` → `done`
  - `message` → `message`
  - `subagent.started` → `subagent.started`
  - `subagent.done` → `subagent.done`
  - `task.created` → `task.created`
  - `task.state_changed` → `task.state_changed`
  - `task.spawned` → `task.spawned`
  - `task.announced` → `task.announced`
  - `task.review_passed` → `task.review_passed`
  - `task.review_failed` → `task.review_failed`
  - `approval.requested` → `approval.requested`
  - `approval.resolved` → `approval.resolved`
  - `validator.result` → `validator.result`
  - `watcher.alert` → `watcher.alert`
  - `tool.called` → `tool.called`
  - `tool.done` → `tool.done`
  - `agent.wake` → `agent.wake`
  - `error` → `error`
- Also emits synthetic `start { streamId, message }` immediately on connect.
- Emits `end` on stream completion.
- Route matches `/chat` and `/chat*`; each request uses the parsed `threadId` as target thread for user message persistence.
- SSE mapping intentionally omits `state` events and does not forward broadcasted state updates.

### 4.5 `POST /chat/sync`

- Reads `message` (required) and optional `targetAgentId`.
- Returns JSON `{ reply }` once `orchestrator.handleUserMessage(...)` completes.
- In practice this path is currently unreachable because the broader `/chat` startsWith route above executes first.
- Body parse errors are currently unguarded and can throw.
- Returns `500` on handler exceptions.

### 4.6 `GET /mcp`

- Calls MCP server with `tools/list` method.
- Returns `{ tools: [...] }` (tool descriptors only).
- Transport path is permissive (`/mcp` plus prefix) and accepts `/mcp*`.

### 4.7 `POST /mcp`

- Accepts JSON-RPC request or batch.
- Passes each request through `McpServer.handleRequest`.
- Returns a single JSON-RPC response or array of responses.
- `initialize` returns:
  - `protocolVersion: "2024-11-05"`
  - `capabilities: { tools: {}, resources: {} }`
  - `serverInfo` with name/version
- `parseJsonRpcRequest` parses both single request and arrays; parse errors in this method are unhandled inside the HTTP handler and can throw to the route scope.
- `notifications/initialized` is accepted as a handled method but returns a JSON-RPC response object even though notifications are expected to be one-way.

### 4.8 `404`

- All unknown routes → `{"error":"Not found"}`.

## 5) WebSocket routes (`src/index.ts`)

### 5.1 Default WS `GET /` (state + events)

- Adds client to `wsClients`.
- Immediately sends snapshot `{ type: "state", data: orchestrator.getState() }`.
- Accepts JSON `ping` frame and responds `{ type: "pong", ts: <epoch-ms> }`.
- Removes client on close.

### 5.2 WS `/voice`

Message types:
- `start`: create/keep `sessionId`, reply `{ type: "session_started", sessionId }`.
- `transcript`: stores text and echoes `{ type: "transcript", text }`.
- `audio_level`: parsed and ignored (reserved for VAD).
- `stop`: runs orchestrator stream flow against the accumulated transcript and emits:
  - `transcript` (raw transcript)
  - incremental `response_delta`
  - `response_done`
  - `session_ended`
- In implementation, `processTranscript(...)` is started without `await`; `session_ended` may arrive before `response_done`.
- Parse errors are intentionally ignored.

## 6) Orchestrator behavior (`src/agent/Orchestrator.ts`)

### 6.1 Initial state

- Starts with one default agent:
  - `main`: orchestrator, trigger `main`, role tools `[Bash, FileRead, FileWrite, Glob, Grep, WebSearch]`.
- Loads recent persisted messages from DB (`getThreadHistory('main', 200)`) into memory.
- Starts watcher and task hydration (`spawnManager.hydrate()`).

### 6.2 Threading and routing

- `handleUserMessage(content, targetAgentId = 'main', alreadyPushed=false)`:
  - resolves target agent (`@agent`, `ask agent`, or on-demand alias in text)
  - inserts `user` message unless `alreadyPushed` is true
  - for `main` target:
    - runs textual agent-management commands
    - else applies `decideAction()`:
      - `voice` default
      - `inject` for phrases like `type this`, `write in`, `fill in`
      - `subagent` for `search/find/look up/research`
  - for non-main target: calls `handleTargetedAgentMessage` with role prompt prep.
- `streamResponse()` is the SSE-facing path; inserts user message first and streams deltas to callbacks.

### 6.3 Agent-management commands

- "create/build/add/make/setup + agent/coder/weather" flows:
  - create coder agent:
    - id `coder`
    - trigger `on-demand`
    - tools `Bash/FileRead/FileWrite/Glob/Grep`
  - create weather watcher:
    - id `weather-watcher`
    - trigger `hourly`
    - tools `WebSearch`
    - interval default 60 minutes
    - immediate initial fetch plus interval scheduling
- Query command (`what agents` / `list agents` / `which agents`) returns text list.
- `ensureAgent` prevents duplicates and returns explicit “already exists” state.

### 6.4 Sub-agent/task creation path

- `handleSubAgentTask`:
  - creates an in-memory sub-agent entry and emits `subagent.started`
  - calls `spawnManager.spawn(...)`
  - emits `task.spawned` and transitions task:
    - `assigned`
    - `in_progress`
  - chooses tool for spawn (`WebSearch` if configured, else `Bash`)
  - executes the tool, emits:
    - `tool.called`
    - `tool.done`
  - on result:
    - updates in-memory sub-agent status/result/error
    - calls `spawnManager.complete(...success/fail...)`
    - emits `subagent.done`
    - summarizes success response via LLM if available, otherwise fallback text.

### 6.5 Targeted agent messages

- For on-demand mentions (e.g. `@Coder`, `ask coder`), builds thread context
  and system prompt:
  - `"You are <agent>. Responsibility: <agent.responsibility>"`
- If no LLM is configured, returns a non-empty fallback message.
- `Weather Watcher` is created as `trigger: hourly` and is not directly targetable via `@` / `ask` patterns.

### 6.6 Streaming response path

- `streamResponse` and `streamVoiceResponse` both:
  - build recent thread context
  - call `llmStream(...)`
  - broadcast `streaming.start`, `streaming.delta`, `streaming.done`
  - on error broadcast `error` and emit `LLM error: ...`
- `streamResponse` persists the final assistant message and triggers compression.
- `streamVoiceResponse` only streams and emits deltas/done; it does not persist assistant messages itself.

## 7) MCP server and adapter (`src/mcp/server.ts`, `src/mcp/adapter.ts`)

### 7.1 MCP JSON-RPC methods

- `tools/list`
- `tools/call`
- `resources/list`
- `initialize`
- `notifications/initialized`
- anything else returns standard JSON-RPC `Method not found` with `-32601`.

### 7.2 MCP methods available through tool names

1. `send_message`
2. `list_sessions`
3. `get_state`
4. `invoke_tool`
5. `voice_start`
6. `voice_stop`
7. `screenshot`
8. `list_messages`
9. `delete_history`
10. `inject_message`
11. `create_task`
12. `list_tasks`
13. `get_task`
14. `transition_task`
15. `spawn_task`
16. `get_spawn_status`
17. `submit_review`
18. `get_review_history`
19. `list_roles`
20. `request_approval`
21. `approve_task`
22. `reject_task`
23. `list_pending_approvals`
24. `run_validators`
25. `get_metrics`
26. `get_task_metrics`
27. `get_alerts`
28. `openclaw_export_state`
29. `openclaw_agent_configs`
30. `openclaw_session_key`
31. `openclaw_resolve_key`

### 7.3 Special MCP method semantics

- `send_message`: required `message`, optional `threadId`; aggregates streaming deltas and returns `{content:[{type:'text',text:...}]}`.
- `screenshot`:
  - without `path`: returns base64 PNG image content (calls `screencapture -x /tmp/helper-screenshot.png`)
  - with `path`: saves screenshot file and returns file path text
- `inject_message`: validates `role` one of user/assistant/system and inserts message directly
- `delete_history`: delegates to DB delete with optional `threadId`
- `list_messages`: supports
  - `threadId` default `main`
  - `limit` cap 200
  - `offset`
  - `direction` `older` (default) or `newer`
- `create_task`: validates with `CreateTaskSchema`
- `spawn_task`: validates with `SpawnRequestSchema` and returns `{taskId, accepted, reason?}`
- `get_state` is declared in MCP tools but has no dedicated implementation in `callTool`; it resolves through fallback and returns `Tool not found: get_state`.
- `list_sessions` is implemented in MCP directly, deriving sessions from in-memory messages and returning:
  - `{ id, name, messageCount, lastMessage: { role, content, timestamp } }`
- `resources/list` is implemented directly in MCP as:
  - `helper://state` (Orchestrator State)
  - `helper://sessions` (Sessions)
  - `helper://agents` (Agents)
- `list_tasks`, `get_task`, `transition_task`, `get_review_history`, approvals, validators, metrics, alerts are direct passthroughs.
- `invoke_tool`:
  - supports `{ name, input }`; defaults to legacy args shape
  - validates with tool schema
  - executes only direct tool registry entries (`allTools`) after parsing.
- `voice_start/voice_stop`: no dedicated handler in MCP call path or adapter; fallback returns `Tool not found: voice_start/voice_stop` from tool registry.

### 7.4 Adapter API exposure

- maps orchestration APIs to MCP-safe interface including:
  - message lifecycle (`sendMessage`, `pushMessage`, `streamResponse`)
  - task APIs (create/list/get/transition/spawn/status)
  - review/approval APIs
  - validators/metrics/alerts
  - OpenClaw interop
- emits tool events through broadcast callback for UI updates.
- `getState()` in the adapter returns tasks/messages/agents and sets `sessions` to `[]` (not materialized by adapter yet).

## 8) Tool surfaces (runtime + control-plane)

### 8.1 Executable tool registry (`src/tools/index.ts`, used by tool calls)

- Registered shared tools: `Bash`, `FileRead`, `FileWrite`, `Glob`, `Grep`, `WebSearch` (`6` entries in `allTools`).
- Tool input schemas are Zod-based (`Tool.inputSchema`).
- Tool call return envelopes are standardized via `Tool.call(...)`.
- MCP `invoke_tool` and sub-agent direct execution both resolve through this registry via `findToolByName`.

### 8.2 MCP control-plane tool registry (`src/mcp/server.ts`)

- `tools/list` exposes: `send_message`, `list_sessions`, `get_state`, `invoke_tool`, `voice_start`, `voice_stop`, `screenshot`, `list_messages`, `delete_history`, `inject_message`, `create_task`, `list_tasks`, `get_task`, `transition_task`, `spawn_task`, `get_spawn_status`, `submit_review`, `get_review_history`, `list_roles`, `request_approval`, `approve_task`, `reject_task`, `list_pending_approvals`, `run_validators`, `get_metrics`, `get_task_metrics`, `get_alerts`, `openclaw_export_state`, `openclaw_agent_configs`, `openclaw_session_key`, `openclaw_resolve_key`.
- MCP status vocabulary: `implemented`, `implemented-partial`, `implemented-target-only`, `blocked`, `missing`.
- `tools/list` payload is MCP control-plane metadata only (`name`, `description`, `inputSchema`); it does not yet emit tool metadata needed by discoverability (`overview`, `instructions`, `basePrompt`, `tags`, `source`, `transport`, search metadata).

MCP tool registry runtime status:

| Tool name | Status | Notes |
| --- | --- | --- |
| `send_message` | implemented | full streaming wrapper via orchestrator path |
| `list_sessions` | implemented | derives sessions from in-memory state |
| `get_state` | blocked | declared in `tools/list`, but no dedicated MCP handler; current fallback returns `Tool not found: get_state` |
| `invoke_tool` | implemented | tool execution path through local `allTools` registry |
| `voice_start` | blocked | no dedicated handler; currently unreachable |
| `voice_stop` | blocked | no dedicated handler; currently unreachable |
| `screenshot` | implemented-partial | works on macOS via local `screencapture`, returns file+base64 |
| `list_messages` | implemented | thread-filtered query with limit/offset |
| `delete_history` | implemented | thread-scoped or full delete bridge |
| `inject_message` | implemented | strict role check in schema, role-specific insert path |
| `create_task` | implemented | validates with role schema |
| `list_tasks` | implemented | passthrough task read |
| `get_task` | implemented | passthrough task read |
| `transition_task` | implemented | passes state transition rules |
| `spawn_task` | implemented | `SpawnRequestSchema` + `taskId` result |
| `get_spawn_status` | implemented | passthrough |
| `submit_review` | implemented | applies pass/fail paths |
| `get_review_history` | implemented | review history passthrough |
| `list_roles` | implemented | returns configured role registry |
| `request_approval` | implemented | creates approval row when needed |
| `approve_task` | implemented | marks approved transition |
| `reject_task` | implemented | marks cancelled on reject |
| `list_pending_approvals` | implemented | approval list passthrough |
| `run_validators` | implemented | runs local validators |
| `get_metrics` | implemented | aggregate metrics path |
| `get_task_metrics` | implemented | per-task metrics path |
| `get_alerts` | implemented | watcher alert passthrough |
| `openclaw_export_state` | implemented | openclaw translation path |
| `openclaw_agent_configs` | implemented | openclaw translation path |
| `openclaw_session_key` | implemented | openclaw translation path |
| `openclaw_resolve_key` | implemented | openclaw translation path |
- Agent/tool permission model for inherited + override capabilities is captured in
  [agent tool capabilities](./agent%20tool%20capabilities/index.md).

### 8.3 Tool runtime specifics

- `Bash`: executes shell command, returns stdout/stderr/exit code.
- `FileRead`: reads file and optional `offset` + `limit`.
- `FileWrite`: writes text content to file.
- `Glob`: returns matching file paths by glob expression.
- `Grep`: runs `grep -r` and returns up to first 50 matches.
- `WebSearch`: currently placeholder; returns DuckDuckGo fallback URL with one synthetic result.

## 9) Task model and persistence (`src/orchestration/*`, `src/db/database.ts`)

### 9.1 DB schema

- `messages` (id, role, thread_id, content, timestamp)
- `diary_entries` (summary, importance, tone, type, created_at)
- `tasks` and lifecycle fields
- `task_events`
- `task_artifacts`
- `task_reviews`
- `task_approvals` with unique pending index per `task_id`

### 9.2 Task engine

- Task statuses:
  - `inbox`, `assigned`, `in_progress`, `review`, `done`, `failed`, `cancelled`, `awaiting_approval`
- Role policy matrix:
  - `orchestrator`, `builder`, `reviewer`, `watcher`, `researcher`, `debugger`
- Valid transitions:
  - `inbox -> assigned|cancelled`
  - `assigned -> in_progress|cancelled`
  - `in_progress -> review|failed|cancelled|awaiting_approval`
  - `review -> done|in_progress|failed|awaiting_approval`
  - `failed -> inbox`
  - `awaiting_approval -> in_progress|cancelled`
- Ledger enforces transitions and prevents invalid transitions.
- Completing review→done requires review gate pass if role requires review.
- Completing from `awaiting_approval` requires approval gate pass.

### 9.3 Spawn constraints (`src/orchestration/spawn-manager.ts`)

- max spawn depth: `3`
- max children per parent: `5`
- max concurrent active spawns: `3`
- timeout clamp: `1..3600` seconds
- spawn lifecycle:
  - `createTask` in ledger (`inbox`)
  - timer set
- hydrate on startup marks previous `in_progress` as `failed` with reason `Server restarted`.
- `complete` and timeout report via callback payload:
  - status `completed | failed | timeout`
  - duration and tool-call count

### 9.4 Reviews and approvals

- `VerificationGate.submitReview`:
  - `pass` or `fail` only
- `fail` requires `repairInstructions`
- reviewer-task role may not have `requiresReview: true`
- escalation threshold default `3` failed reviews
- `Orchestrator.submitReview` behavior:
  - pass ⇒ task `done` + `task.review_passed`
  - fail + escalation ⇒ `awaiting_approval` + `requestApproval` + `task.review_failed`
  - fail otherwise ⇒ `in_progress` + `task.review_failed`
- `ApprovalGate`:
  - one pending approval per task (DB unique constraint)
  - `approveTask` ⇒ task `in_progress`
- `rejectTask` ⇒ task `cancelled`

### 9.5 Validation and metrics

- Validators:
  - `lint` (`pnpm exec eslint src`)
  - `typecheck` (`pnpm exec tsc --noEmit`)
  - `test` validator exists but adapter defaults to lint + typecheck only
- `validator.result` event includes validator name, pass flag, output, duration.
- Aggregate metrics:
  - `totalTasks`, `byStatus`, completion and failure rates, avg repair depth, avg duration
- Task metrics:
  - `durationMs` for terminal tasks
  - `reviewCount`
  - `repairDepth`
  - `timedOut` when last event reason contains `timeout`

### 9.6 Watcher alerts

- interval: 60s
- `stale`: non-terminal task not updated past threshold
- `loop`: repeated status revisits (status repetition threshold in window)
- `runaway_spawn`: active assigned/in-progress child tasks above threshold
- active alerts are deduplicated and retained capped at 100.

## 10) Conversation compression (`src/engine/compression.ts`)

- `evaluateAndCompress` runs on assistant responses:
  - requires minimum chat volume (>=3 user + >=2 assistant messages)
  - sends transcript to LLM for JSON scoring
  - writes diary entry when `worthy=true` and `importance > 1`
  - preserves `emotionalTone` and `entryType`
  - runs `compressDiary` (max active entries: 50; low-importance entries are faded)

## 11) LLM streaming and providers

- `src/llm/client.ts`:
  - non-stream chat endpoint to OpenAI / MiniMax
- `src/llm/streaming.ts` supports streaming parsers for both providers:
  - OpenAI: `v1/chat/completions` with `stream: true`
  - MiniMax: `v1/text/chatcompletion_v2` with `stream: true`
- `minimax`: reads `MINIMAX_API_KEY` and `LLM_PROVIDER=minimax`
- `openai`: reads `OPENAI_API_KEY` or `OPENAI_CHAT_API_KEY`

## 12) OpenClaw interop

- `src/openclaw/role-agent-adapter.ts` exports role-based agent configs.
- `session-mapper.ts` maps Nessie references to `agent:<id>:nessie:channel:<taskId>` keys.
- `event-translator.ts` maps selected Nessie events:
  - task lifecycle
  - review and approval
  - validator and watcher
  - message events
- `announce-converter.ts` maps task announce payload to OpenClaw status/output format.

## 13) Remote control-plane and MCP-first management

### 13.0) MCP control plane as canonical management bus

- MCP is the canonical control plane for operator actions, including project lifecycle, channel lifecycle, agent lifecycle, tool registration/import, bindings, secrets, and release workflows.
- Existing HTTP routes are for compatibility; every non-trivial action should have a matching MCP tool/action in control-plane registry.
- All management actions should include actor and policy context:
  - `actorContext` (`actorId`, `actorType`, `teamId`, `projectId`, `channelId`, `requestId`),
  - `approval` and proof field when required,
  - deterministic audit trace with action source.
- Required auth for all control-plane operations:
  - authenticated actor context,
  - policy chain evaluation (`organization` → `project` → `team` → `channel` → `agent` → `tool`),
  - reasoned deny output with canonical codes,
  - immutable audit record.
- Orchestrators should be able to execute MCP control commands such as:
  - create/update/delete org and project
  - create/update/delete channels
  - create/update/deploy/disable agents
  - import/register/remove tools
  - set memberships and grants
  - rotate/revoke secrets
  - `degrade` / `archive` / `restore` / `delete` project safety flows.

#### 13.0a) Universal parity rule (HTTP, MCP, and chat)

Every control and runtime capability must be reachable via:

- a typed MCP action in the control registry,
- either a direct HTTP endpoint (compatibility) and/or a chat parser path.

If MCP action and HTTP route diverge, both must share the same:

- deterministic input schema,
- actor context and approval requirements,
- reason codes,
- audit log shape.

Parity matrix:

| Capability class | HTTP/transport target | MCP action | Chat command | Policy | Approval | Audit | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| runtime health | `GET /health` | `health.get` | `/system health` | actorContext | no | yes | target-only |
| runtime state | `GET /state` | `system.get_state` | `/system state` | actorContext | no | yes | implemented-target-only |
| history delete | `DELETE /history` | `history.delete` | `/history delete` | actorContext | no | yes | implemented-target-only |
| message submit (stream) | `POST /chat` | `message.submit` | `/message submit` | actorContext | conditional | yes | implemented-partial |
| message submit sync | `POST /chat/sync` | `message.submit_sync` | `/message submit --sync` | actorContext | conditional | yes | blocked (route shadow) |
| mcp list | `GET /mcp` | `mcp.tools.list` | N/A | actorContext | no | yes | implemented |
| mcp call | `POST /mcp` | MCP JSON-RPC router | N/A | actorContext | no | yes | implemented |
| service checks | `GET /healthz`, `GET /readyz` | `system.healthz`, `system.readyz` | N/A | actorContext | no | yes | target-only |
| organization | `GET/POST /orgs` | `org.create`, `org.update`, `org.list` | `/org create` | org policy | create/update/delete: yes | yes | blocked |
| project lifecycle | `GET/POST /projects` | `project.create`, `project.update`, `project.delete` | `/project create` | org + project policy | yes for unsafe transitions | yes | blocked |
| project members | `POST /projects/{projectId}/members` | `project.members.add`, `project.members.remove` | `/project members add/remove` | project policy | yes | yes | blocked |
| channel lifecycle | `POST /channels` | `project.channels.create`, `project.channels.update`, `project.channels.members.search` | `/channel create` | project/channel policy | yes | yes | blocked |
| agent catalog | `GET/POST /agents` | `agent.register`, `agent.update`, `agent.bind`, `agent.unbind` | `/agent register` | project/team/channel policy | yes | yes | blocked |
| tool catalog | `POST /tools` | `tool.import`, `tool.update`, `tool.bind`, `tool.unbind` | `/tool import` | project + transport policy | yes | yes | blocked |
| role binding | `POST /roles` | `role.assign`, `role.revoke` | `/role assign` | admin-role policy | yes | yes | blocked |
| channel membership | `POST /channels/{channelId}/members` | `channel.member.add`, `channel.member.remove` | `/channel member add` | channel policy | yes | yes | blocked |
| session tools | `POST /sessions/{action}` | `session.start`, `session.read`, `session.send`, `session.interrupt`, `session.status`, `session.close` | `/session start`, `/session send` | project + channel + tool policy | yes for long-running/privileged | yes | blocked |
| policy operations | `GET /policy/effective`, `.../preview`, `.../apply` | `policy.effective`, `policy.preview`, `policy.apply` | `/policy effective` | admin policy | yes | yes | blocked |
| secret operations | `POST /secrets` | `secrets.create`, `secrets.update`, `secrets.rotate`, `secrets.revoke`, `secrets.delete`, `secrets.resolve`, `secrets.access_check` | `/secret create` | secret + project/team/channel policy | resolve/rotate/revoke/delete: yes | yes | blocked |
| project safety | `POST /projects/{projectId}/safety/preflight`, `.../degrade`, `.../restore`, `.../archive`, `.../restore`, `.../delete` | `project.safety.preflight`, `project.safety.degrade`, `project.safety.restore`, `project.archive`, `project.delete` | `/project safety` | governance + project-state policy | yes | yes | blocked |
| step-up verification | `POST /verification/challenges/*`, `GET/POST /verification/factors*` | `verification.challenge.start`, `verification.challenge.verify`, `verification.challenge.resend`, `verification.challenge.cancel`, `verification.factor.enroll`, `verification.factor.verify`, `verification.factor.revoke`, `verification.factor.list` | `/verify`, `/verify enroll` | high-risk action policy | conditional | yes | blocked |
| language + translation | `GET/PATCH /orgs/{orgId}/language`, `GET/PATCH /users/{userId}/language`, `PATCH /threads/{threadId}/language`, `PATCH /sessions/{sessionId}/language`, `POST /translation/preview` | `translation.org.get`, `translation.org.update`, `translation.user.get`, `translation.user.update`, `translation.thread.update`, `translation.session.update`, `translation.preview` | `/language set`, `/translate preview` | org/user/thread/session policy | org default change: yes | yes | blocked |
| token ledger + pricing | `POST /ledger/tokens/events`, `GET /ledger/tokens/events`, `GET /ledger/tokens/summary`, `GET/POST /ledger/tokens/pricing`, `DELETE /ledger/tokens/pricing/{profileId}`, `GET /ledger/tokens/monthly-estimate` | `ledger.tokens.event.ingest`, `ledger.tokens.events.list`, `ledger.tokens.summary.get`, `ledger.tokens.pricing.list`, `ledger.tokens.pricing.upsert`, `ledger.tokens.pricing.delete`, `ledger.tokens.monthly_estimate.get` | `/ledger tokens`, `/ledger pricing` | org/admin policy; team owners read usage only | pricing override: yes | yes | blocked |
| knowledge base | `POST /knowledge-base/*` | `knowledge_base.link`, `knowledge_base.search`, `knowledge_base.read`, `knowledge_base.search_summary`, `knowledge_base.reindex`, `knowledge_base.projects.share` | `/knowledge search` | project/team/channel policy | read: no; write/share: yes | yes | blocked |
| CLI tool imports | `POST /tools/import` | `tool.import` (cli/unified toolset manifest), `tool.update` | `/tool import` | project + role + tool policy | yes for unmanaged tools | yes | blocked |

### 13.0b) Chat command strategy and control envelope

- user instructions are converted into deterministic command identifiers in a versioned registry.
- parsing must return:
  - `UNKNOWN_COMMAND` with recovery hints,
  - `AMBIGUOUS_COMMAND` with deterministic tie-break guidance.
- supported commands are strict patterns, not free-form interpretation.
- slash-command aliases (for UX) map one-to-one to the same control action envelope.
- destructive actions return `requires_approval` when required proof is missing.
- `workspace` is a legacy alias for `project`; all new APIs and docs must use `project`, and legacy input must be canonicalized before policy evaluation.
- all new `/api` control-plane routes return `ApiResponse<T>` or `ApiError` from [shared-type-contracts-spec.md](./shared-type-contracts-spec.md).

Control action envelope:

```ts
type ControlActionEnvelope = {
  action: string;
  commandId: string;
  commandVersion: string;
  context: AuthorizedActionContext;
  payload: Record<string, unknown>;
};
```

The `context` field is the canonical shared contract from [shared-type-contracts-spec.md](./shared-type-contracts-spec.md). Lower-level services must consume it directly rather than defining a second mapping type.

```ts
type ControlCommandDefinition = {
  commandId: string;
  commandVersion: string;
  pattern: string; // example: "/tool import"
  action: string;
  destructive: boolean;
  approvalRequired: boolean;
  recoveryHints: string[];
  allowedScopes: ('organization' | 'project' | 'team' | 'channel')[];
};
```

- `remote/cmd/control-server/main.go` currently exposes:
  - `GET /healthz`
  - `GET /readyz`
- no control/agent endpoints yet.

### 13.0c) Deployment bootstrap and self-provisioning

- a deployment should expose bootstrap hooks to register/verify:
  - organization and project roots,
  - default channels,
  - hidden organizers,
  - base tool catalog,
  - baseline RBAC/deny policies.
- bootstrap operations must be idempotent and replay-safe.
- deployment should support “reconcile from toolsets” flow:
  - load local manifests,
  - load remote signed marketplaces,
  - create/disable catalog entries based on admin policy,
  - persist allow/deny with actor audit.
- expected deployment outcome:
  - if no interactive login is required, system is controllable via MCP/chat immediately,
  - if bootstrap policy is restricted, initial operations are denied with explicit remediation actions.

## 13.1) Tool discovery requirements for `/admin`

- `/admin` should treat tool selection as a scoped query operation and avoid loading all tool entries at startup.
- Required tool surface fields for every registered entry:
  - `overview` (search result summary),
  - `instructions` (human-use constraints),
  - `basePrompt` and prompt override mode,
  - `tags` and `tag` filtering,
  - deterministic search metadata (`updatedAt`, `etag`, pagination cursor).
- A mock-first interface should support flows:
  - initial warm-up query for enabled tools in current scope,
  - typed full-text search (`q`),
  - faceted tag filtering and transport/source filters,
  - deterministic paging before showing raw tool call UI.
- Required query contract to keep discovery reproducible:
  - default stable sort: `updatedAt DESC, source ASC, label ASC, id ASC`,
  - deterministic cursor derived from `(updatedAt, id)`,
  - stable tie-breaker on lexical `id`,
  - response includes `updatedAt`, `etag`, `cursor`, `total`, `filtered`, `page`, and `pageSize`.
  - for `/tools/search`, `scope` refers to discovery scope or registry slice, not visibility/privacy state.

## 13.2) Slack-style agent communication (implementation target)

- Add first-class **channels** and **channel membership**.
  - every thread can be scoped to a channel,
  - each channel carries default responder policy and permissions.
- Add a hidden **organizer** for each scope:
  - sees all inbound messages,
  - resolves implicit mentions,
  - selects one responder by default,
  - emits routing rationale for audit.
- Default outbound behavior remains single-response unless users explicitly request broadcast.
- Allow explicit addressing patterns:
  - direct agent (`@coder`, `ask coder ...`),
  - direct channel (`@research`, `@ops`, `@channel`),
  - multi-tag mention in one message (`@coder @reviewer`),
  - explicit broadcast (`@all`, `@channel`),
  - explicit opinion mode (`all perspectives`, `ask everyone`).
- Support stable nested agent chains (3+ depth supported by design):
  - each agent stores `parentAgentId` and `subAgents`,
  - routing remains depth-aware and deterministic.
- Expose routing trace for organizer-visible decisions, not always user-visible spam.
- New state/events required:
  - `routing.started`, `routing.decision`, `routing.chosen`, `routing.trace`,
  - `agent.pointOfView` entries for optional multi-view display,
  - `channel.membership` in orchestrator state.
- Explicit semantics: multi-tag mention selects only the tagged agents; all others remain quiet unless explicit broadcast is requested.
- Reference design file: [agent-communication-spec.md](./agent-communication-spec.md).

## 13.2a) Parallel execution loops with stable orchestration

- Target-state design only. Any managed agent will be able to define a stage-based execution pipeline:
  - parallel candidate generation,
  - aggregation,
  - refinement or critique loops,
  - re-evaluation loops.
- Parallelism and loops are different:
  - parallelism compares multiple candidates for the same stage,
  - a loop consumes the previously selected best output in a later stage.
- These must be composable:
  - one loop can contain multiple parallel candidates,
  - one pipeline can have several loop stages.
- Aggregation must support three executors:
  - the same agent,
  - a fixed orchestrator agent,
  - the hidden channel organizer,
  - a custom agent chosen for a stage-specific review pass.
- When a fixed orchestrator is configured, that same orchestrator identity should collect all findings across the pipeline and choose what advances to the next stage.
- Aggregation payload must include:
  - every candidate output,
  - candidate provenance (`provider`, `model`, `agentId`, `runId`, `stageId`),
  - evaluation metadata and reason codes.
- Audit requirement:
  - selected output plus rejected candidates are stored in the task ledger,
  - user-visible thread shows only the selected result unless `show all` is requested.
- Terminology:
  - `fixed orchestrator agent` = `fixed-agent` mode in the execution policy,
  - `hidden channel organizer` = `channel-organizer` mode,
  - `stable orchestrator` = the same orchestrator reused across aggregation passes in one pipeline.
- Cross-link:
  - [agent tool capabilities](./agent%20tool%20capabilities/01-foundations.md),
  - [agent-communication-spec.md](./agent-communication-spec.md).

## 13.3) SSH remote execution requirement (single entry tool)

- Add a dedicated SSH tool with one catalog entry (`ssh`) that supports:
  1. run mode (single command, terminate when command completes),
  2. session mode (persistent background SSH session with follow-up `session:send`/`session:read`).
- In run mode, SSH should expose command output, exit code, and close immediately.
- In session mode:
  - `sessionId` is returned from `session:start`,
  - agent can send more instructions over time,
  - organizer can pause or resume communication against that session for the same thread context,
  - closing should send terminal exit and cleanup handles.
- Require explicit host allowlist and optional key allowlist in tool policy.
- Default deny for unsafely configured hosts/keys and unknown command envelopes.
- Cross-link:
  - interactive session schema: [agent tool capabilities](./agent%20tool%20capabilities/04-interactive-tools.md).

## 13.4) Knowledge base linking and retrieval requirements (no context pollution)

- Knowledge sources must be importable as a first-class tool action:
  - folder path,
  - local document,
  - MCP docs endpoint,
  - remote URL (subject to allowlist + fetch policy).
- Ingestion should emit or compute per-source summary metadata (`title`, `summary`, `sourceUri`, `tags`, `checksum`, `updatedAt`) before source is used in answers.
- Query path should return compact metadata-first hits:
  - short snippets,
  - provenance IDs,
  - score or rank,
  - policy reason and visibility scope.
- Full document text must not be automatically injected into context.
- Full text access requires explicit `read` action and policy check for visibility.
- Search behavior must support both deterministic index mode and optional semantic mode.
- Thread-level ephemeral retrieval:
  - short-lived shortlist in memory or temp store,
  - bounded by `topK`, TTL, and source cap,
  - isolated to thread/channel actor context.
- Project-level retrieval:
  - each project has independent knowledge source namespace,
  - default searches are project-scoped unless explicitly global,
  - searches cannot cross project without explicit project sharing rule.
- UI/agent must avoid loading all registered documents at startup; must use scoped search query endpoints with tags/filter/sort/cursor.
- Cross-link:
  - requirements doc: [knowledge-base-requirements.md](./knowledge-base-requirements.md),
  - one-file tool family definition patterns: [agent tool capabilities](./agent%20tool%20capabilities/02-checkbox-ui-api.md).

## 13.4a) Remote worker execution CLI requirement

- Add a first-class `RemoteWorker` concept for customer-owned execution clients on macOS, Windows, and Linux.
- Remote workers register to a parent Nessie control plane, which may be hosted cloud or organization-owned infrastructure.
- The remote worker is distinct from a hosted runner:
  - hosted runner = Nessie-owned cloud execution boundary,
  - remote worker = customer-owned machine registered into the Nessie control plane.
- Idle connection model:
  - remote worker performs lightweight heartbeat/poll requests,
  - default target interval can be around 60 seconds,
  - heartbeat response may shorten or extend the next interval,
  - idle workers should not keep a websocket open by default.
- Setup/handshake model:
  - worker is configured with parent URL + bootstrap credential,
  - parent returns worker-scoped auth material,
  - worker reports capabilities, local sandbox summary, and local policy digest,
  - policy changes on either side must be synchronized to the parent instance.
- Active connection model:
  - when poll/heartbeat says work exists, the worker opens a websocket with a short-lived ticket,
  - cloud agents then use that session to drive interactive command/file/process operations,
  - when work finishes, the worker returns to heartbeat mode.
- Remote worker capability surface should be declarative:
  - `shell.run`,
  - `shell.session`,
  - `file.read`,
  - `file.write`,
  - `file.glob`,
  - `ssh.run`,
  - `ssh.session`,
  - `cli.wrapper`,
  - optional `mcp.proxy`.
- Policy rule:
  - effective permission = local hard policy on the worker
  - intersected with cloud policy
  - intersected with current actor context.
- Local hard policy is non-bypassable by the cloud:
  - allowed roots,
  - denied roots,
  - read-only mode,
  - allowed commands,
  - denied commands,
  - interactive on/off,
  - max runtime/output/session count,
  - local confirmation requirements.
- Cloud policy must support parallel restriction layers on the same remote worker:
  - org,
  - project,
  - team,
  - channel,
  - agent,
  - tool,
  - remote-worker binding.
- Remote workers must be project-scoped by default and hidden from unauthorized channels/users/agents.
- Cross-link:
  - [remote-worker-spec.md](./remote-worker-spec.md),
  - [organization-governance-spec.md](./organization-governance-spec.md),
  - [agent tool capabilities](./agent%20tool%20capabilities/04-interactive-tools.md).

## 13.5) Organization, project, and channel access control (implementation target)

- `Organization`: top-level tenant boundary with owned users and teams.
- `Project`: isolated release boundary inside an organization.
  - own secrets, knowledge documents, tool execution policy, and agent membership.
- `Team`: work boundary inside an organization with controlled agent/tool privileges.
- `Channel`: scoped collaboration context inside a team with visibility `public` / `protected` / `private`.
- Membership and binding tables:
  - `ProjectMember` (project membership),
  - `UserTeam` (team membership),
  - `ChannelMember` (channel membership),
  - `ProjectAgentBinding` (project placement for an agent),
  - `AgentBinding` (team/channel placement for an agent),
  - `TeamToolBinding` and `ChannelToolBinding` (who can use what where).
- `ProjectToolBinding` (project-specific tool constraints).
- Access chain to enforce:
  1. org policy,
  2. project policy,
  3. team policy,
  4. channel policy,
  5. role/agent policy,
  6. tool policy.
- UI/route behavior:
  - private/protected channels and restricted agents are not discoverable to non-members,
  - unresolved mentions should return guided alternatives (`request access`, `switch team`, `join public channel`),
  - broadcast is constrained by visibility and tool access checks.
- Cross-link:
  - full governance spec: [organization-governance-spec.md](./organization-governance-spec.md).

## 13.5a) Deployment modes and auth behavior

- Nessie must support:
  - hosted SaaS mode,
  - self-hosted organization mode,
  - single-machine local mode.
- Hosted and self-hosted installations must share the same control-plane and data model.
- Hosted auth default:
  - `authentication.unlikeotherai.com` as the primary login entrypoint,
  - optional direct auto-redirect to SSO when exactly one auth path is configured.
- Self-hosted/local auth:
  - configurable provider system,
  - one or more SSO providers,
  - provider chooser page by default,
  - optional `autoRedirectToSso`,
  - local installs must be able to disable auto-redirect.
- Model/provider credentials are separate from user authentication and stay in the secret system.
- Local install requirement:
  - Docker-first startup,
  - supported non-Docker startup,
  - simple global launcher command,
  - all state lands locally by default.
- Target local launcher experience:
  - `npm install -g nessie`
  - `nessie local up`
- Non-Docker dependency model:
  - `Postgres` required,
  - `Redis` optional,
  - `MinIO` optional,
  - local filesystem object storage should be the default simplest mode.
- Launcher must expose dependency checks and guidance:
  - `nessie local doctor`,
  - missing dependency detection,
  - degraded mode explanation when optional services are absent.
- Cross-link:
  - [deployment-modes-and-auth-spec.md](./deployment-modes-and-auth-spec.md).

## 13.6) Secret storage and retrieval (encrypted, scoped, policy-gated)

- Contract status: target-state design, not currently implemented.
- Secrets must never be stored in chat, model context, or visible tool call payloads.
- Secret writes happen through secure REST endpoints and return only a `secretRef` in runtime-facing payloads.
- Current implementation has no vault service; these are behavior targets only.
- Supported scopes:
  - `global`, `project`, `team`, `channel`, `agent`, `thread`, `user`, `service`.
- Scope is explicit:
  - broader scope does not create implicit nested read unless explicitly bound.
- Secret definitions and values are encrypted at minimum with 256-bit standard.
- Tool configs hold `secretRef` only; runtime resolves secrets in a non-chat execution path.
- Resolves must pass policy checks on actor binding + scope + project + role and emit auditable deny reasons.
  - policy chain: org -> project -> team -> channel -> explicit secret bindings, deny-first at each layer.
- API contracts to support:
  - `POST /secrets` (create),
  - `GET /secrets` (metadata list),
  - `GET /secrets/{secretRef}` (metadata),
  - `PATCH /secrets/{secretRef}` (metadata updates),
  - `POST /secrets/{secretRef}/resolve` (runtime use),
  - `POST /secrets/{secretRef}/grants` (binding ops),
  - `GET /secrets/{secretRef}/grants`,
  - `DELETE /secrets/{secretRef}/grants/{grantId}`,
  - `GET /secrets/audit`,
  - `POST /secrets/access/check` (pre-execution policy),
  - `POST /secrets/{secretRef}/rotate`,
  - `POST /secrets/{secretRef}/revoke`,
  - `DELETE /secrets/{secretRef}` (removal/purge policy aware).
- UI requirement:
  - pop-up for secret value capture and scope selection (`global`, `project`, `team`, `channel`, `agent`, `thread`, `user`, `service`).
  - capture popup supports out-of-band submission and copy-only `secretRef`.
  - UI must show last-used + last-rotated warning state; stale secrets must be blocked until explicit override.
- Cross-link:
  - [secret-management-spec.md](./secret-management-spec.md),
  - [organization-governance-spec.md](./organization-governance-spec.md).

## 13.7) Enterprise and regulated-workload use cases (preload)

- Multi-cloud operator model:
  - one org with multiple regulated project boundaries (finance/health/platform) sharing audit tooling but never shared secrets or source indexes.
  - explicit project freeze (`project.safety.degrade`) on deployment credential issues.
- M&A/account separation:
  - new teams/contractors onboarded with temporary project-local grants.
  - tenant-level secrets revoked automatically on contract termination.
- Privileged access management:
  - mandatory dual-approval for sensitive secret rotations and destructive project state changes.
  - short-lived approval windows and immutable proof in project audit.
- Incident response:
  - emergency global stop via project-safe mode prevents blast radius spread across unrelated projects.
  - kill-switch path must block deploy and mutation actions before incident escalation completes.
- Compliance and policy control:
  - region-aware project placement and review-friendly deny reasons for every read/rotate/revoke event.
  - explicit retention and purge requirements tied to project boundaries.
- Marketplace/partner isolation:
  - partner-owned projects can run local tools and knowledge sources with read-only boundaries against internal corpora.

## 13.8) Additional enterprise and workflow use cases

- Platform operations and incident recovery:
  - channel-specific playbooks, role-limited incident responders, scoped tool grants, and temporary kill-switch actions.
- FinOps governance:
  - project budgets, spend-limited agent actions, cost-scoped approvals, and policy-driven export controls.
- MLOps and data operations:
  - isolated model-serving projects with per-project host egress allowlists and secret scopes.
- Customer operations:
  - multi-customer tenant model where each org/project has dedicated channels, agents, and audit namespace.
- Regulated workflows:
  - regional residency constraints, dual-control for sensitive state transitions, and immutable change trails per project.

## 13.9) Step-up verification add-on

- Email verification and authenticator QR enrollment are reusable step-up factors, not single-feature hacks.
- The add-on must work for deployments, external email sends, privileged tool use, secret rotation, and other high-risk actions.
- Factor proofs attach to the same control action envelope used for approval gating and audit.
- TOTP seeds and recovery material are secrets and must be stored outside chat.
- Cross-link:
  - [step-up-verification-spec.md](./step-up-verification-spec.md).

## 13.10) Multilingual communication and translated delivery

- each organization can define one canonical communication language.
- each user can define one preferred delivery language.
- each user should be able to define pronouns/profile references used by the translation layer.
- if a user wants "all communication in Turkish", the system should translate inbound/outbound communication for that user while keeping canonical persistence in the organization language.
- inbound messages in another language are translated into the organization default language before routing and storage.
- outbound messages are translated per-recipient after canonical response generation.
- translation calls should include a bounded recent-message context window by default:
  - current message plus up to 2 previous thread messages,
  - participant pronoun/profile hints when available,
  - trimmed to policy/token budget,
  - enough for terminology and conversational coherence.
- canonical thread history, exports, and audit should default to the organization language.
- original-language retention is optional and must be policy-controlled; if retained, it is non-authoritative metadata.
- cross-link:
  - [language-and-translation-spec.md](./language-and-translation-spec.md),
  - [agent-communication-spec.md](./agent-communication-spec.md),
  - [organization-governance-spec.md](./organization-governance-spec.md).

## 13.11) Token ledger and monthly cost estimation

- each organization should have a token ledger for every model call across every provider.
- ledger should capture:
  - input tokens,
  - output tokens,
  - cached-token or cache-hit metrics when the provider exposes them,
  - provider/model identity,
  - task/thread/project/team/channel/agent attribution.
- admins and owners should be able to define custom pricing overrides for estimates.
- reports should show:
  - provider-reported cost when available,
  - Nessie-estimated cost using the active pricing profile,
  - monthly estimate and rollups by org/team/project/channel/agent/model.
- translation model usage should also flow into the same token ledger.
- cross-link:
  - [token-ledger-spec.md](./token-ledger-spec.md),
  - [organization-governance-spec.md](./organization-governance-spec.md).

## 13.10) Workflow builder and agent design (target state)

- Contract status: target-state design. See [docs/plans/2026-04-07-workflow-builder.md](./plans/2026-04-07-workflow-builder.md) for the full spec.
- Workflows are registered as tools in the tool catalog. Any agent with `invoke_workflow` in its tool list can execute any workflow it has policy access to.
- Workflows do not create new conceptual primitives — they are deterministic tool calls composed from existing node types.
- Agents replace human users: creating an agent is the equivalent of adding a team member in a Slack-style interface.

### Workflow node types

| # | Type | Purpose |
|---|------|---------|
| 1 | Trigger | Entry point — manual, scheduled, webhook, event, voice |
| 2 | Agent | AI agent step with prompt and tools |
| 3 | Tool | Direct tool invocation, no agent overhead |
| 4 | Router | Branch on LLM evaluation or condition |
| 5 | Fork | Fan out to N parallel branches |
| 6 | Join | Collect parallel results, resume single flow |
| 7 | Human Input | Pause and wait for a human response (channel broadcast or DM) |
| 8 | Project | Filesystem scope injection via dashed context edge |
| 9 | Secret | Vault key reference — value resolved at runtime via dashed inject edge |

### Trigger subtypes

Each workflow and agent has exactly one trigger:

| Subtype | Activation |
|---------|-----------|
| `manual` | Direct `invoke_workflow` call or UI "Run" button |
| `scheduled` | Cron expression |
| `webhook` | `POST /workflows/{id}/trigger` |
| `event` | Named internal event (e.g. `task.review_passed`) |
| `voice` | Voice command pattern match |
| `on-demand` | @mention or direct message (agent-level trigger only) |

### Human Input suspension model

When a Human Input node is reached:
1. Workflow run transitions to `waiting_for_input`
2. A message is sent to the configured target (channel or DM)
3. Execution suspends — the run creates a task in `awaiting_approval`
4. Human replies in chat → response attached to run → execution resumes
5. Response available as `humanInput.text` to downstream nodes

### Eval pattern

Evals use a standard Agent node with a structured verification prompt, not a separate node type. A toolbox preset ("Eval") pre-wires an Agent node to a Router with `passed / failed` branches.

### New DB tables (target)

- `workflows`: id, name, description, graph_json, trigger_type, trigger_config, created_at, updated_at
- `workflow_runs`: id, workflow_id, task_id, status, inputs, outputs, error, started_at, finished_at

### New MCP tools (target)

`invoke_workflow`, `create_workflow`, `update_workflow`, `delete_workflow`, `list_workflows`, `get_workflow_run`, `list_workflow_runs`

## 14) Known limitations / explicit stubs

- Route matching uses prefix checks in `index.ts`; `/chat/sync` is shadowed by the `/chat*` SSE handler.
- `onStateChange` does not broadcast state payloads; WS only gets an initial snapshot on connect, while `state` broadcasts are only sent by explicit emits (for example `/history` delete).
- SSE mapping omits `state` events even when broadcast emits them.
- SSE `tool.done` payload currently carries only `{ name }`; tool output is available in server event but dropped in SSE transport.
- MCP JSON-RPC parsing still lacks route-level parse guards for `/chat`, `/chat/sync`, and `/mcp`.
- `voice_start` and `voice_stop` are listed in MCP tool defs but not implemented in adapter behavior.
- `WebSearch` returns a fallback URL result (placeholder integration).
- `GET /mcp` returns tool list only; full resources discovery is still MCP-only in the transport.
- adapter-level state shape still omits a concrete session list (`sessions` always `[]`) where that state is surfaced outside the `/state` HTTP route.
- `screenshot` relies on host `screencapture` binary (macOS behavior).
- No auth layer exists on HTTP/MCP/WS in current implementation.
- No project model exists yet (`Project`, `ProjectMember`, `ProjectAgentBinding`, project-scoped policy).
- No secret project-scoping implementation yet: secrets are not isolated by project namespace.
- No cross-project guard for secrets, knowledge source, or agent routing yet (all isolation is conceptual).
- No one-file tool bundle import path yet (`toolset.{json|yaml|md}`).
- No manifest marketplace index fetch/verify flow yet; tool onboarding is static from code.
- No one-file manifest ingest contract yet for deterministic discovery metadata (`overview`, `instructions`, `basePrompt`, `tags`) in imported catalogs.
- No knowledge base ingestion/summarization/search pipeline yet; no deterministic thread-level ephemeral index.
- No organization/channel membership model yet.
- No team-aware visibility enforcement for protected/private channels.
- No end-to-end access-policy evaluation chain (`organization -> team -> channel -> role -> agent -> tool`) yet.
- `tools/list` is static and cannot filter/search by tag, transport type, or allow/deny state.
- No deterministic tool search endpoint, so initial UI can get polluted with full tool payloads.
- No hidden routing organizer (Slack-style dispatcher).
- No channel-scoped routing with single-responder arbitration layer.
- No stage-based execution pipeline with stable orchestrator aggregation across parallel passes.
- No interactive process tool family for long-lived Codex/Claude sessions (`session:start`, `session:send`, `session:read`, `session:close`).
- No dedicated SSH tool entry yet (`ssh` with run/session modes).
- No scoped secret vault with encryption-at-rest and actor/agent/channel-level grants.
- No per-tool/per-agent sandbox policy enforcement for path allow/deny and read-only constraints.
- No centralized prompt inheritance/override model for agents and tools.
- No workflow builder UI or workflow graph executor.
- No `invoke_workflow` tool or workflow CRUD endpoints.
- No Human Input suspension mechanism (`waiting_for_input` run status).
- No trigger scheduler for `scheduled`, `webhook`, or `event` trigger subtypes on workflows or agents.
- No remote worker registration, heartbeat, websocket-connect, or effective-policy evaluation path yet.
- No worker-scoped API-key/bootstrap generation path yet for parent-instance registration.
- No project/channel/agent-scoped remote worker bindings yet.
- No local-hard-policy plus cloud-policy intersection model implemented for customer-owned execution clients.
- No deployment-mode abstraction yet for hosted versus self-hosted versus single-machine local installs.
- No configurable auth-provider registry or local `autoRedirectToSso` behavior yet.
- No Docker-first local launcher flow yet for `nessie local up`.
- No documented non-Docker local dependency-check flow yet (`nessie local doctor`, required vs optional services, degraded-mode behavior).

## 15) New web UI mapping (for mock-first build)

To cover parity at runtime, the web interface should model:

- Connection status + host/port + protocol (HTTP/WS/SSE/MCP)
- Realtime event stream viewer for SSE and WS events
- Thread/session list from `threadId` grouping
- Chat input + in-flight delta rendering + full reply
- Task table with status/history transitions
- Tool console for MCP tool calls and outputs
- Approval/review widgets
- Metrics and watcher alerts panels
- Agent registry and weather/coder agent management actions
- History deletion controls and state refresh
- OpenClaw and diagnostics panel (optional for backend parity)

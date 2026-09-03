# Nessie Functionality Map (Source-of-Truth)

> Status: active implementation reference plus target-state control-plane map.

As of `2026-04-07`, this document captures all implemented runtime behavior in the Node backend and control-plane code that the future authenticated Nessie interface should mirror, then consume via mocks.

Interpretation rule:
- the root app layout and phase-roadmap cross-links at the top of this file are target-state guidance,
- the route and runtime sections below still describe the current legacy `src/index.ts` server unless a section explicitly says otherwise.
- legacy runtime capabilities such as host `Bash`, `FileWrite`, and other privileged local tools must not be treated as Phase 1 MVP requirements for the new `/api` + `/admin` architecture.
- new Phase 1 backend endpoints for the rebuilt product should be rooted under `/api/...` as defined in [implementation-phases.md](./implementation-phases.md).

The checkbox-based tool policy model is documented as a separate target-state design in [agent-tool-capabilities](./agent-tool-capabilities/index.md), and is currently not fully enforced at runtime.

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

### 2.0 Live first-party DeepSignal boundary (`api/` + `worker/`)

- Per-user activation creates one integration-managed `external_mcp` DM and a
  user-scoped instance pinned to the deployment secret reference
  `DEEPSIGNAL_MCP_APP_KEY`; generic install/OAuth/lifecycle/secret paths cannot
  mutate it. Only the canonical product-linked public catalog can back the
  instance, and outbound app-key requests are pinned to
  `https://api.deepsignal.live`.
- Initial and follow-up chat, history hydration, and proactive insight digests
  retain the DeepSignal-issued `dsk_` bearer and independently add
  exact-scope UOA delegation plus fresh signed user/org/team/agent/run/request/
  tool-call provenance. Missing hosted configuration, incomplete identity, or
  a stale generic credential, stale identity header, or cross-role key reuse
  fails closed without Nessie inference.
- Activation reuses the user's existing linked UOA subject and active workspace;
  there is no secondary DeepSignal OAuth tab. The webhook HMAC secret is a
  separate per-org credential and cannot reuse an app key.
- The live routes are
  `POST /api/integrations/products/deepsignal/activate`,
  `POST .../deactivate`, `POST /api/channels/:channelId/external-sync`, and
  `POST /api/integrations/deepsignal/events`.

### 2.0a Live first-party DeepWater grant boundary

- Team enablement installs the five Ledger-backed `research_*` projections;
  `deep_water_run_update` is the sixth required registry entry. All six remain
  default-off for every agent until that agent's exact `toolPolicy` key is
  `true`; install scope and tenancy are still required after a grant.
- Owners manage individual explicit entries on `/agents/tools` through
  `GET /api/mcp/tools/policy-targets` and targeted per-entry `PATCH` requests.
  This minimal target list includes the Personal Assistant without widening the
  normal `/api/agents` response or exposing private assistant bindings/activity.
  Each write merges one key under a database lock, preserving all unrelated
  allow and deny entries. DeepWater projections lock team transition first and
  re-read the current projection before taking the agent lock.
- `GET/PATCH /api/integrations/products/deep-water/agent-access` reports and
  changes the complete six-entry bundle for the Personal Assistant or shared
  agents. The launcher disables research until its PA has 6/6 and the launch
  API repeats the check under team-then-policy locks before persisting a run.
  The updater counts only while its registry entry is enabled and active, so a
  stale policy allow cannot authorize a launch the worker cannot finish.
- Generic agent create/edit cannot write protected grants or server provenance;
  stale edits preserve current protected values, while clones and spawned
  subtask children strip them. PA bootstrap config cannot inject them, generic
  agent responses redact provenance markers, and Agent Designer directs owners
  to Tools/Integrations. Generic shared-agent creation, listing, parent
  selection, hierarchy/status/activity/realtime reads, and channel binding are
  scoped to the exact active organization.
  The updater cannot be switched off individually while a DeepWater
  bundle/projection depends on it. Its row remains known to cleanup while
  disabled, so revocation clears the old allow before a later registry re-enable.
- Disabling the team integration returns `LEDGER_DEEPWATER_ACTIVE_RUNS` while a
  run is queued, running, or awaiting setup. Cancel/recover it or wait for a
  terminal result before retrying. Admin integration caches are scoped by
  user/org/team/privilege, including DeepSignal signal digests.
  Mutation completions invalidate those scoped families instead of writing a
  response through mutable render scope, so switching workspace mid-request
  cannot place the old response in the new workspace cache.
  Bundle or individual lifecycle revocation also returns 409 for those
  nonterminal states; no force-revoke path can strand Ledger work. Handoff
  message, run attachment, PA run/task, and direct `run.execute` enqueue commit
  atomically; product handoffs bypass chat engagement decisions while ordinary
  chat routing is unchanged. Duplicate enqueue conflicts roll back the
  duplicate unit, and realtime is post-commit/non-fatal. Ambiguous null-id work
  still blocks disable because Ledger dispatch may be in flight. Agent access
  remains visible after disable so retained bundle provenance can be revoked.
  Its individual-tools link stays in exact DeepWater mode after teardown: with
  no current instance it shows only the canonical updater, never the full
  registry.

### 2.0b Live SSO-authored billing and credits interface

- UOA supplies the complete display-ready statement, shared-team credits,
  recurring add-ons, and customer-action models. Nessie only checks the active
  linked workspace, validates the shared public protocol, renders it, and
  proxies its frozen actions.
- API validation and admin view-model types come directly from the public
  MIT-licensed `@unlikeotherai/billing-statement-protocol` 1.2.0 workspace
  vendored byte-for-byte from UOA commit
  `698765f`. Root lint verifies the pinned
  SHA-256 manifest, preventing a Nessie-specific billing contract fork.
- The statement uses protocol V2 and one exact Ledger
  `metering-portfolio-v1` `group_by=user` snapshot. UOA supplies the complete
  connected-service totals, origins, per-user shares, and display copy from
  that same snapshot; Nessie performs no cross-service aggregation or share
  calculation. The frozen customer-action protocol remains V1.
- Every active team member can read the same selected-team credit balance.
  The headline is remaining credits, followed by pending, added, and used
  credits for the current period, a connected-service breakdown, recent credit
  activity, and automatic top-up status. UOA fixes the conversion at 1,000
  credits per US$1 and returns every amount and label ready to display; Nessie
  never converts money, tokens, provider cost, or raw Ledger units into credits.
  Billing managers receive named user and payment-management detail. Ordinary
  members receive their own usage plus anonymous other-member and unattributed
  totals. Their pending-payment amount and funding policy are absent, and their
  automatic top-up view contains only UOA's payment-method status plus a notice
  that detailed settings are managed by billing managers; they receive no
  payment details or mutation actions.
- Manual top-ups, automatic top-up setup/update/disable/recovery, and recurring
  add-on subscribe/cancel actions are manager-only frozen UOA actions. Products
  do not persist a balance, payment method, consent, subscription, add-on, or
  top-up state. The same UOA team credit account is therefore visible from
  Nessie and every other connected product without a product-local balance.
- Upgrade, portal, cancellation preview, and cancellation confirmation stay on
  Nessie's own pages but carry only UOA-authored paths, bodies, display copy,
  choices, and opaque tokens. No tariff, total, access, or cancellation decision
  is calculated locally.
- Exact UOA Checkout return markers on `/` preserve their full query while
  routing to Credits & Billing. That customer surface contains only UOA-authored
  credits, add-ons, statements, and actions; Nessie-local token, connector,
  file, budget, pricing, cost, and projection telemetry lives on the separate
  owner-only `/ops/usage` page. The credits page displays a neutral notice and
  refetches UOA's canonical statement, credits, and recurring add-ons; invalid
  or duplicate markers retain the normal Channels landing behavior and cause
  no billing action.

### 2.0c Live personal-assistant workspace provisioning boundary

- Four PA-only builtins let the assistant do to an existing workspace what its
  owner can do by clicking: `agent_list`, `channel_create`,
  `agent_bind_channel`, and `agent_trigger_create`
  (`worker/src/run/pa-tools/provisioning.ts`). Each calls the same service
  function as its REST route and reproduces that route's authorization exactly —
  no weaker, no stronger.
- **`agent_create` lives in the same file but is not reachable from the PA.**
  Creating and redesigning an agent belongs to the Agent Designer: those tools
  carry `identityDelegatedOnly`, which removes the Personal Assistant's own arm
  from the `personalAssistantOnly` gate, and the PA hands the conversation over
  with `agent_handoff` instead (see the global-agent surface,
  `docs/global-agents.md`). The tool itself is unchanged — member-level, mapping
  to `POST /api/agents` — it is simply the Designer's to call.
- `agent_list` (`GET /api/agents` → `listAgentsForUser`) is the read the two
  id-taking tools depend on: an owner clicking picks the agent from a list, so
  without it the assistant could only bind or schedule an agent it had created
  in the same conversation. It is `safe: true`, scoped by entitlement (owner:
  every non-system agent including unbound ones; anybody else: agents bound to
  channels they can see — never narrowed by the session's project/team), and
  returns only what the caller needs to act: name, role, `agentId`, and the
  channels the agent is bound to. An optional `query` narrows that
  already-authorized list by name or role.
- The admin **Agents page** (`/agents`) groups the same entitlement-scoped list
  into three tabs — **Personal** (`agentKind === 'personal_assistant'`), **Team**
  (ordinary shared agents), and **Global** (system-provided `systemManaged`
  agents, read-only) — over a paginated, zebra-striped table. Selecting a row
  opens its detail surface, the single doorway for the integrated designer and
  Design Assistant (`admin/src/components/features/agents/AgentsList.tsx`).
  The scope is derived from `agentKind`/`systemManaged`, not a stored column. To
  populate the Personal and Global tabs, `GET /api/agents` accepts `?scope=all`,
  which includes the read-only system tier under the *same* channel-visibility
  filter (`listAgentsForUser(..., includeSystemManaged)`); every other caller,
  the `agent_list` tool included, omits the param and gets the unchanged
  non-system list.
- `agent_list` and `channel_create` (`POST /api/channels`) are open to any
  active member, because those routes carry only `requireActorContext`.
  `agent_bind_channel`
  (`POST /api/agents/:agentId/bindings`) requires channel membership, refuses any
  system channel, requires owner, and then passes
  `checkPolicy(…, 'agent', 'bind', …)`. `agent_trigger_create`
  (`POST /api/agents/:agentId/triggers`) requires owner plus an accessible
  agent, parses the route's own `CreateAgentTriggerBodySchema`, and stamps
  `launchOrigin` (creator + UOA workspace) on scheduled and interval triggers;
  a signing deployment refuses a schedule with no UOA identity.
- `agent_create` cannot escalate: its schema exposes no
  `agentKind`/`systemManaged`/`surfacePolicy`/`delegationMode`/`parentAgentId`,
  and `assertGenericAgentToolPolicyInput` refuses every `requiresExplicitGrant`
  key and DeepWater provenance marker, so an agent authored from chat can never
  arrive with research already granted. There is no assistant tool for agent
  delete or tool-policy targets; agent *update* exists but, like creation, is the
  Agent Designer's alone.
- The acting user's role is re-read from the live `OrganizationMember` row on
  every call, and a deactivated membership is refused — the run's
  `actorContext` is an enqueue-time snapshot, while the API re-resolves the role
  per request. Owner-gated tools remain visible to non-owners and refuse in
  words, naming who can perform the action.
- The shared implementations live in `@nessie/workspace-admin`, consumed by both
  the API routes and the worker; `api/src/services/*` re-exports them so route
  code is unchanged.

#### 2.0c.1 Agent to-do tracking API

- Per-agent to-do templates and materialized checklist instances are available
  under `/api/agents/:agentId/todo-templates*` and
  `/api/agents/:agentId/todos*`. Every route inherits
  `isAgentAccessibleToActor`; inaccessible agents return `AGENT_NOT_FOUND`, and
  an accessible agent with `todosEnabled = false` returns
  `AGENT_TODOS_DISABLED`.
- Template writes are owner-only configuration. Any entitled active member may
  create an instance; only its creator, an organization owner, or the agent's
  steward may tick or cancel it. Templates pin a version and copy ordered steps
  into each instance, so later edits cannot rewrite work already in progress.
- Step updates serialize on a per-to-do transaction advisory lock, record the
  structural actor and timestamp, and derive completion when every step is
  `completed`, `skipped`, or `failed`. Failures remain visible but do not leave
  an otherwise terminal checklist open. An agent cannot overwrite a terminal
  status set by a person; a person may correct any step. Cancelling never
  changes the linked run.
- An active template can repeat through an ordinary agent trigger with
  `config.todoTemplateId`; the To-dos tab is the owner-facing creation and
  repair doorway. The shared trigger write validates that the template is
  active, belongs to that agent, and that to-dos remain enabled. An enabled
  referencing trigger blocks archival (`TODO_TEMPLATE_IN_USE`) and disabling
  to-dos (`AGENT_TODOS_IN_USE`); pausing it is the explicit repair path.
- A scheduled fire carries template provenance through the existing pending
  queue. The run that adopts the thread slot creates one pinned instance per
  distinct template (so coalesced duplicate fires make one checklist), while
  unfinished prior instances remain facts for the model rather than being
  rolled over, cancelled, or automatically adopted. A template that disappears
  before adoption moves its trigger to the existing owner-alerted `error`
  health state exactly once.

### 2.0d Policy-gated tool approvals

- A `requiresApproval` tool policy is a true execution pause, not a model-visible
  denial. The worker creates one approval request per `(runId, toolCallId)`,
  checkpoints the run with `reason: 'approval_required'`, stamps its
  disclosure basis on the waiting notice, and transitions the run, task, and
  agent to `waiting_approval`, `awaiting_approval`, and `waiting_approval`.
- Approving creates exactly one continuation run through the same
  claim-once checkpoint pattern as manual continuation. The continuation
  restores the original actor context and can dispatch only the approved tool
  with the approved canonical arguments: the opaque continuation token is
  verified against its approval row, organization, direct run lineage, tool
  name, and argument hash, then consumed at dispatch. The token and the full
  resume state are server-only and never appear in approval responses.
- A tool rule with `conditions.reviewMode: 'auto'` runs one `NESSIE_UTILITY_MODEL`
  reviewer after deterministic authorization and before dispatch, only for unsafe
  builtins, real remote MCP calls, and `executor.browser.act` / `executor.command.run`.
  A deterministic denial still wins; an allow dispatches, a deny returns
  `auto_review_denied`, and an escalation, timeout, or malformed response enters
  this same human-approval pause. Each reviewer verdict is a `tool.auto_reviewed`
  task event plus an audit-chain `policy.evaluated` record.
- Rejecting, expiry, and cancellation terminalize the waiting run, update the
  durable approval-gate notice, leave the checkpoint unconsumed for an ordinary
  follow-up, and release the thread slot. The entitled `/approvals` surface is
  reachable in context through its pending-count sidebar badge and its thread
  approval card, which resolves through the same approval API and realtime events.

### 2.0e Channel scopes

- A channel belongs either to a visible project or to the organisation's
  standalone **Channels** section. Project channels always render beneath their
  project; standalone channels never impersonate a project or a UOA workspace.
- The database keeps standalone channels in one hidden, system-managed channel
  root per organisation because a channel requires a project and team foreign
  key. That root is an internal container, not a second copy of UOA's
  organisation or workspace hierarchy, and it is excluded from project APIs and
  navigation.
- Slugs are unique within their owning project. Therefore `#general` may exist
  once in the standalone section and once in each project; the channel creation
  surface selects the scope explicitly.

### 2.1 Server bootstrap (`src/index.ts`)

> **REMOVED — legacy `src/` only.** The legacy server described in sections 2–6 is being deleted. The live stack is `api/` (port 5454) + `worker/` + `admin/` (port 5455), launched by the `nessie` CLI. Sections 2–6 are retained as a historical record.

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

### 6.4b Agent chat cards

Agents post interactive cards into a conversation with the `card_post` builtin
(default-on for every agent). The card row is the authority; the assistant
message carries only `metadata.agentCard = { cardId, schemaVersion }`.

- `GET /api/agent-cards/:cardId` — viewer-scoped presenter: title, subtitle,
  service mark (a Nessie-served icon path or null), the presented blocks, the
  actions, status, `action` (`respond` | `none`), who it is waiting for, and the
  resolution when settled. Gated on organisation, thread visibility and the card
  message's disclosure basis; an unreadable card 404s exactly like an absent one.
- `POST /api/agent-cards/:cardId/respond` — `{ actionKey, values?, secrets? }`.
  One transaction: claim `open → resolved`, place any secret through the same
  seam and authorization as `POST /api/mcp/instances/:id/secret`, and write the
  response as a `user` message stamped `metadata.agentCardResponse`. A run
  parked on the card is resumed by the press; otherwise the card's agent is
  woken. Errors: `404 CARD_NOT_FOUND`, `403 CARD_NOT_RESPONDENT`,
  `409 CARD_NOT_OPEN`, `422 CARD_INVALID_VALUES`, plus the instance-secret
  route's own codes.
- Realtime `card.updated` `{ cardId, messageId, threadId, status }` — ids and
  status only, content-free by construction.

Full behaviour: [plans/2026-09-01-agent-chat-cards.md](plans/2026-09-01-agent-chat-cards.md).

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

> **REMOVED — legacy `src/` only.** The JSON-RPC MCP server documented in this section (`GET /mcp`, `POST /mcp`, `tools/list`, `send_message`, `invoke_tool`, and the 37 tools below) existed only in the legacy `src/` tree, which is being deleted. The live `api/` server has no JSON-RPC `/mcp` endpoint. The live API exposes a **REST connector-management surface** under `/api/mcp/*` — see `api/src/routes/mcp.ts` for the authoritative current surface. The sections below are retained as a historical record of what was removed.

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
  [agent-tool-capabilities](./agent-tool-capabilities/index.md).

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
- Agent lifecycle semantics:
  - `active`: agent can be routed, bound, edited, and spawned.
  - `retired`: default end-of-life state. Agent remains visible in history, admin views, and audit records, but cannot be routed, bound to new channels, or used for new runs until restored.
  - `deleted`: destructive cleanup path. The live agent record is removed permanently. Historical artifacts and audit entries remain immutable and must render tombstoned attribution such as `Deleted agent` plus last known display name when available.
- Terminology rule:
  - use `retire` / `restore` for reversible lifecycle changes,
  - use `delete` only for permanent destructive cleanup,
  - never use informal labels such as `dead agent` in UI or docs.
- Orchestrators should be able to execute MCP control commands such as:
  - create/update/delete org and project
  - create/update/delete channels
  - create/update/deploy/retire/restore/delete agents
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

### Draft-safe write contracts (auto-saving editors)

Every admin surface that holds unsent words auto-saves it
(`docs/navigation/overview.md` §12), so the write endpoints behind them are idempotent
or conditional rather than last-write-wins.

**Client idempotency key — `POST /api/threads/{threadId}/messages`.** The body
accepts `clientMessageId` (1–200 chars); the `Idempotency-Key` request header
is accepted as the transport spelling of the same value and the body field wins
when both are present. It is stored on `Message.clientMessageId` and is unique
per thread — PostgreSQL treats NULLs as distinct, so every message posted
without one, including every agent reply and every pre-existing row, is
unaffected and no backfill is needed.

- A first send behaves exactly as before: **201** with
  `{ message, pendingAgentInvites }`.
- A retry carrying a key the thread already holds returns **200** with that
  same message and an empty `pendingAgentInvites`. The first attempt's
  attachment linking, mention alerts, push dispatch and agent orchestration are
  **not** replayed.
- Two attempts racing past the pre-check are resolved by the unique index; the
  loser replays the winner rather than surfacing a conflict.
- The admin composers mint one key per unsent draft, hold it while the attempt
  is unresolved, and mint a fresh one after a success or a channel switch.

**Optimistic concurrency — `If-Match`.** Three update routes accept the
revision the caller edited, as a bare number, a quoted one, or a weak ETag:

| Route | Version token | Conflict code |
| --- | --- | --- |
| `PUT /api/dashboards/{id}/layout` | `Dashboard.revision` | `DASHBOARD_REVISION_CONFLICT` |
| `PUT /api/workflows/{workflowTemplateId}` | `WorkflowTemplate.version` | `WORKFLOW_TEMPLATE_VERSION_CONFLICT` |
| `PATCH /api/knowledge-base/pages/{pageId}` | `KnowledgePage.revision` | `KNOWLEDGE_PAGE_REVISION_CONFLICT` |

- A mismatch answers **409** with `error.details.currentRevision`, so the
  client can offer "take theirs" without a second round trip, and writes
  nothing.
- A header the server cannot parse is **400 `INVALID_IF_MATCH`** — never
  silently treated as absent, because that would turn a client bug into an
  overwrite.
- A missing header, or `*`, means "no opinion" and saves unconditionally. That
  is deliberately the "keep mine" answer a person chooses after seeing the
  conflict.
- `KnowledgePage.revision` is new (migration
  `20260902130000_knowledge_page_revision`, default 0, incremented on every
  update): `versionNumber` lives on the per-version row and cannot serve an
  `If-Match`.

Parity matrix:

| Capability class | HTTP/transport target | MCP action | Chat command | Policy | Approval | Audit | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| runtime health | `GET /health` | `health.get` | `/system health` | actorContext | no | yes | target-only |
| runtime state | `GET /state` | `system.get_state` | `/system state` | actorContext | no | yes | implemented-target-only |
| history delete | `DELETE /history` | `history.delete` | `/history delete` | actorContext | no | yes | implemented-target-only |
| message submit (stream) | `POST /chat` | `message.submit` | `/message submit` | actorContext | conditional | yes | implemented-partial |
| message submit sync | `POST /chat/sync` | `message.submit_sync` | `/message submit --sync` | actorContext | conditional | yes | blocked (route shadow) |
| conversation start | `POST /api/channels/conversations` then `POST /api/threads/{threadId}/messages` | N/A | N/A (sidebar compose icon -> `/channels/new`; agent `@mentions` -> their direct-message conversation) | organization membership; agent recipients require owner | no | no | implemented (the recipient-addressed composer opens as a focused full-screen task with Close on phone and an accessible modal sheet over the retained Channels workspace on tablet/desktop; Close returns to the initiating internal route or `/channels` for a direct link, while a successful send replaces the composer with the new conversation. An agent `@mention` resolves or creates its one-to-one DM and opens it ready for a message. The composer autocompletes people and agents, opens a single-user DM or single-agent DM for one recipient, and creates a stable group DM for mixed or multi-recipient chats after the first message. Group DMs appear in Direct messages, never in Projects or Channels.) |
| unread direct-message inbox | GET /api/direct-messages/unread | N/A | N/A (Channels sidebar → **Unread messages**, rendered directly beneath **Threads** only while at least one DM is unread) | acting user’s entitled DM channels plus the standard read-time disclosure predicate | no | no | implemented (one row per unread direct-message channel, ordered by its latest unread message and carrying a compact preview, relative time, and unread count. A row opens its DM; the route uses the existing channel/read and per-reply conversation cursors, never a second unread store. Deleted and disclosure-restricted messages remain navigable but render an honest placeholder rather than content.) |
| thread activity inbox | `GET /api/threads/activity` (`?unread=true` narrows to unread followed reply conversations) | N/A | N/A (Threads → **Unread only** in the page header) | acting user’s followed, entitled reply conversations plus the standard read-time disclosure predicate | no | no | implemented (the page header’s toggle is persisted only in device-local browser storage, never in account preferences; it queries the server-side unread projection so it covers the full inbox rather than just the loaded cards. Marking a thread read updates the visible card or removes it from the unread-only list without resetting the page.) |
| message reaction | `POST /api/threads/{threadId}/messages/{messageId}/reactions` + realtime `message.reaction` | N/A | N/A (message row action toolbar) | channel membership | no | no | implemented (REST admin surface; users can tap/click a message row to copy it from the first action, add themed emoji reactions, reply in a thread, and edit/delete their own messages; tapping an existing reaction removes it, while hovering, keyboard-focusing, or long-pressing a reaction pill shows who reacted (member/agent display names). Skin tone preference is stored in an admin cookie; the same picker opens from the composer smiley button to insert emoji into a draft at the caret. On phone layouts the composer picker does not focus its search field when opening, so the keyboard cannot cover the picker; tapping Search still opens it when needed.) |
| message file attachments | `POST /api/uploads` (multipart part `file`, ≤ 25 MiB, stored through the FileService chokepoint: EXIF strip, storage accounting, quota gate), `GET /api/messages/{messageId}/attachments`, `GET /api/attachments/{id}` (inline for raster images/PDF, download otherwise; `private, max-age=1y, immutable` + a strong `ETag` over id+size, `If-None-Match` answered 304 — attachment bytes are immutable, so the browser cache serves repeat renders off the network), `GET /api/attachments/{id}/thumbnail` (small WebP preview, same ACL and caching as the original, 404 when the file has none so the client falls back), `DELETE /api/attachments/{id}` (discards the uploader's own still-unlinked staged upload, including its `-bytes` accounting event; refuses anything referenced by a message, KB page, logo, avatar, or feedback item), `POST /api/threads/{threadId}/messages` with `attachmentIds` (max 10, linked only to the sender's own still-unlinked uploads; `content` is optional when at least one attachment is present — attachment-only posts store empty content, and an attachment-only reply broadcast via "Also send to #channel" carries a fallback copy line) | N/A | N/A (composer paperclip with multi-file picker; staged chips with per-file upload progress, inline errors, and remove; drag-and-drop onto the main chat column or onto the reply-thread panel in all three panel modes; tapping an inline preview opens a full-size viewer over the app — original bytes, Escape/backdrop close, focus trap, body scroll lock, download action, PDFs in an iframe with the blob MIME pinned; works from the feed, the reply panel, and the info drawers) | channel/thread membership for send and message-attachment reads; uploader-scoped upload/discard | no | no | implemented (admin composer + REST; the feed renders the **thumbnail**, lazily, never the full-resolution original — a 11.6 MB photo paints from a 42 KB preview — and files with no preview keep the download chip. Previews are generated at the FileService chokepoint: inline for raster images from the bytes the EXIF strip already buffers, and via the `attachment.thumbnail` worker job for PDFs (first page, PDFium/WASM), animated/exotic images, oversized images, and orgs opted out of stripping; `thumbnailStatus` is pending/ready/unavailable and failures are never fatal. Thumbnails are quota-gated with the original, carry their own `store.thumbnail`/`delete.thumbnail` usage events, and are freed by the same `FileService.delete` as the original. Attachments stored before this existed have no thumbnail and are not backfilled. `ThreadMessageRecord.attachmentCount` lets the feed skip the per-message attachment fetch entirely for messages with no files. Oversize files are rejected client-side before any network call and server-side with 413 `FILE_TOO_LARGE`; storage-quota exhaustion surfaces 507 `STORAGE_QUOTA_EXCEEDED` inline on the staged chip) |
| message reply threads | `POST /api/threads/{threadId}/messages` with `rootMessageId` (+ `alsoSendToChannel`), `GET /api/threads/{threadId}/messages?rootMessageId=...`, `GET /api/threads/{threadId}/messages/{messageId}`, `PUT /api/threads/{threadId}/messages/{messageId}/follow` + realtime `message.reply` / `message.reply.meta` | N/A | N/A (message row "Reply in thread" action or `T`; right-hand thread panel at `/channels/{id}/threads/{id}/replies/{rootId}`) | inherits container thread/channel visibility (no separate ACL) | no | no | implemented (Slack-parity side conversations one level deep off any top-level message: collapsed reply-summary bar with participant avatars/count/last-reply time under roots, resizable third-pane thread panel with pinned root and full composer including "Also send to #channel" broadcast copies, deep-linkable route, pushed full-screen below 900px; per-root materialized replyCount/lastReplyAt/participant ids maintained transactionally; MessageThreadFollow auto-follows on participate, while the chat presents no manual follow or unfollow control; the header's left-side Back button returns to the channel; agent runs reply into the triggering message's reply thread by default while product handoffs stay top-level; reply-unread badges and the Threads inbox are #212/#213) |
| agent thought process (thinking bubbles) | `GET /api/threads/{threadId}/thinking` (live runs of the thread with their reply anchor, tail log, and `lastChunkId`), `GET /api/threads/{threadId}/runs/{runId}/thinking` (full log: last 500 entries with a `truncated` flag) + realtime `stream.start` (`rootMessageId`), `stream.reasoning`, `stream.thinking.tool` | N/A | N/A (dashed thinking bubble at the bottom of the surface the reply will land on; tap/click opens the full thought-process dialog) | same gate as the thread SSE stream (thread/channel visibility); the run must belong to that thread | no | no | implemented (backend; the worker's per-run thought recorder persists coalesced visible reasoning and one line per tool call to `run_thinking_chunks` and publishes each flush with its chunk id, so the live bubble is lossy but the record is not; `stream.*` is never replayed from the SSE backlog, so mid-run joiners bootstrap over REST and dedupe by `chunkId`; chunk ids are BigInt columns serialized as strings) |
| model-judged reply placement | `POST /api/threads/{threadId}/messages` (orchestration side effect; replayed by `POST /api/runs/{runId}/restart`) | N/A | N/A (reply lands in the trigger's reply thread or in the main channel window) | channel membership | no | no | implemented (the engagement-decision model call also returns `replyPlacement` — `thread` when the answer belongs to the asker's exchange, `channel` when it is a standalone contribution to the room, defaulting to `thread` — stored on `Run.replyPlacement`; @mentions and Personal Assistant DMs stamp `thread` structurally with no model call; resolution precedence is DeepWater handoff/external agent → top-level, then an already-in-thread trigger → that root, then a `channel` judgement → top-level, else the trigger message; the resolved anchor is persisted on `Run.replyRootMessageId` for REST readers) |
| message author profile + quick DM | `POST /api/dm/{userId}` then `GET/POST /api/threads/{threadId}/messages` | N/A | N/A (tap/click a non-DM message author's avatar/name, including your own, or tap yourself in the DM list) | organization membership + DM channel membership | no | no | implemented (admin chat opens a right-side user info drawer that reuses the channel feed/composer against the DM thread; the sidebar keeps the signed-in user available as a one-member self-DM target; disabled when already viewing that DM) |
| message agent profile + quick mention | `GET/POST /api/threads/{threadId}/messages` | N/A | N/A (tap/click an agent-authored message avatar or name) | channel membership + agent visibility | no | no | implemented (admin chat opens a right-side agent info drawer that reuses the channel feed/composer for the current thread, filters to the selected agent exchange, and addresses quick prompts with `@agent`; disabled in the Personal Assistant DM) |
| user, agent, and channel favourites | `GET /api/favorites`, `PUT/DELETE /api/favorites/{targetType}/{targetId}` | N/A | N/A (star beside the admin chat title and Starred sidebar section) | actor's org + visible channel/person/agent target | no | no | implemented (REST admin surface; the chat title star persists per signed-in user for channels, one-to-one DMs including self-DM, and the Personal Assistant agent. A favourite is rendered only in Starred—not duplicated in its original Channels, Projects, or Direct messages location—and the starred PA follows the active DM route.) |
| user alerts (mentions) | `GET /api/alerts` (cursor + `unread` filter, response carries `unreadCount`), `POST /api/alerts/read` (`ids` or `all`), realtime `alert.created`/`alert.read` | N/A | N/A (top-bar alerts bell with unread badge + dropdown; full list at `/alerts`) | actor's org + own user id (alerts are private to their recipient) | no | no | implemented (a direct @mention writes a durable `mention` `UserAlert` row per mentioned user in the message-create transaction — self-mentions skipped, broadcast mentions create no rows, agent-authored mentions identical; mute suppresses the push but never the row; mentioned users get `<author> mentioned you in <channel>` push framing; dropdown/page rows deep-link into the channel with message highlight; `alert.read` syncs read state across devices) |
| mcp list | `GET /mcp` | `mcp.tools.list` | N/A | actorContext | no | yes | implemented |
| mcp call | `POST /mcp` | MCP JSON-RPC router | N/A | actorContext | no | yes | implemented |
| service checks | `GET /healthz`, `GET /readyz` | `system.healthz`, `system.readyz` | N/A | actorContext | no | yes | target-only |
| organization | `GET/POST /orgs` | `org.create`, `org.update`, `org.list` | `/org create` | org policy | create/update/delete: yes | yes | blocked |
| project lifecycle | `GET/POST /api/projects`, `GET/PATCH/DELETE /api/projects/{projectId}` | `project.create`, `project.update`, `project.delete` | `/project create` | org + project policy (delete: owner, refused while project still has channels) | yes for unsafe transitions | yes | implemented (REST admin surface) |
| project members | `GET/POST /api/projects/{projectId}/members`, `DELETE /api/projects/{projectId}/members/{userId}` | `project.members.add`, `project.members.remove` | `/project members add/remove` | project policy (owner) | yes | yes | implemented (REST admin surface) |
| user statuses | `GET/POST/PATCH/DELETE /api/statuses`, `POST /api/statuses/{statusId}/activate`, `DELETE /api/statuses/active`, status schedule/rule subroutes | `status.*` | `/status set` | self-user policy | no | no | implemented (REST admin surface; contact-rule dispatch not wired) |
| presence | `GET /api/presence` (org-wide live state + active-status emoji map), `PUT /api/presence/me` (manual Active/Away override; `null` reverts to auto), `POST /api/presence/heartbeat` (client liveness + activity) | N/A | N/A (account menu → Availability) | actor's org (read); self (write) | no | no | implemented (REST admin surface) — three states online/away/offline; offline when the heartbeat goes stale, away when idle >5 min / tab hidden / manual, else online. Polled by the admin to badge every human avatar; the signed-in user's own dot is derived locally for instant feedback. |
| organisation appearance | `GET/PATCH /api/organizations/current` (set/clear round logo via `logoAttachmentId`), `GET /api/brand/logo` (public — serves the logo of the organisation the **instance operator** designated as the sign-in brand, `Organization.instanceBrand`, set out of band by `nessie set-instance-brand`; none designated or no logo uploaded → 404 and the static Nessie mark). It is not inferred from the instance holding one organisation any more: that silently stopped working under per-UOA-org tenancy and let one tenant's admins own everybody's login screen | `org.get`, `org.logo.update` | N/A (Settings → Appearance → Logo; the instance designation is CLI-only, see `docs/deployment.md`) | actor's org; PATCH requires owner/admin and cannot set the instance designation | no | yes | implemented (REST admin surface) |
| active workspace switch | Local sessions: `POST /api/auth/switch-context` with the exact local organisation/project/team. Renewable UOA sessions: `POST /api/auth/uoa/workspace` with the external organisation/team, authorized and re-signed through UOA's explicit refresh-family workspace-switch grant. Both require the current bearer plus matching HttpOnly refresh cookie and return a replacement access session/cookie. Refresh and switching share one client mutation coordinator; every replacement session that changes user or organisation/project/team cancels and clears tenant query caches before the new token renders, including ordinary refresh after another tab switches. | N/A | N/A (shared desktop/iPad/phone workspace menu; a selected row shows progress; ambiguous response loss reconciles through ordinary refresh and treats the recovered target as success, while definitive target refusal names the retained workspace) | exact live local membership or UOA-verified product policy + organisation/team membership + target 2FA assurance | no | no | implemented (existing workspaces switch in-app; **Add a workspace** still opens hosted UOA) |
| user profile photo | **UOA session:** `PUT /api/auth/me/avatar/uoa` (multipart part `file`, PNG/JPEG/WebP ≤ 1 MiB, relayed to UOA `PUT /domain/users/{uoaSub}/avatar`) and `DELETE /api/auth/me/avatar/uoa` (idempotent clear); the subject is always the acting user's own `User.uoaSub`, resolved server-side and never taken from the request. **No-UOA deployment:** `PATCH /api/auth/me/avatar` (set/clear a local attachment via `avatarAttachmentId`; bytes uploaded via `POST /api/uploads`) — refused for a UOA session with `403 PROFILE_MANAGED_BY_SSO`, because UOA owns that profile and a local upload would override the picture it holds. Clients resolve the precedence `GET /api/users/{userId}/avatar` (UnlikeOtherAI) → `avatarAttachmentId` (local upload) → `avatarUrl` (provider/Google `picture`) → initials; **Gravatar was removed from the chain and from every API record** | `auth.me` (self) | N/A (Settings → Profile → Profile photo — one panel that routes to the relay or the local attachment by session provider); avatar menu in the rail; every human avatar in the admin | actor's own (write) | no | yes | implemented (REST admin surface) |
| UnlikeOtherAI avatar relay | `GET /api/users/{userId}/avatar` — image bytes for any member of the caller's organisation, relayed from UOA `GET /domain/users/{uoaSub}/avatar` with the domain-hash bearer (UOA's own precedence: uploaded → proxied provider picture → generated SVG). The subject comes from `ProductAccountLink` (`productSlug = nessie`) scoped to the caller's organisation, which is also the tenancy gate. Unlinked user or unconfigured UOA → cacheable `404` (clients fall through to the next source: the local upload, then the provider picture, then initials); unreachable/unusable upstream → `502`. Relays only `image/png\|jpeg\|webp\|svg+xml`, with `nosniff`, `content-security-policy: default-src 'none'` and `cache-control: private, max-age=300`. No new environment variables — reuses `UOA_DOMAIN` + `UOA_CLIENT_SECRET` | N/A | N/A (rendered by every `UserAvatar`) | any actor in the target's organisation | no | no | implemented (REST admin surface) |
| workspace (company) avatar | `GET/PUT/DELETE /api/workspace/avatar` plus read-only `GET /api/teams/{teamId}/avatar` — the company image UOA holds for a workspace, relayed to UOA `/domain/teams/{externalWorkspaceId}/avatar` with the domain-hash bearer (UOA precedence: uploaded → proxied team `iconUrl` → generated SVG). `PUT` takes multipart part `file` (PNG/JPEG/WebP ≤ 1 MiB, magic-byte validated by UOA); `DELETE` is idempotent. Current-workspace reads and mutations resolve the actor's **session** team through their organisation and accept no team id. UOA's authenticated `/org/me` directory supplies a public, always-resolving `avatarImageUrl` for every workspace the caller may enter; UOA's public image route is rate-limited and non-enumerating, and Nessie resolves relative URLs against the configured UOA origin before storing them. `/auth/me` also reconstructs that public URL from the external team id for sessions created before UOA added the directory field, and pins `size=128` so clients do not reuse a cached response from before cross-origin embedding was enabled. The switcher uses the existing membership-scoped relay where a local `avatarTeamId` exists (preserving immediate cache-busting after edits), otherwise the public UOA URL, and finally initials. It groups teams under their owning organisation by stable organisation id on desktop, iPad, and phone. **The domain hash is full system trust and UOA's `/domain/*` mutations apply no role check — Nessie's owner/admin gate on `PUT`/`DELETE` is the only authorization.** Same relay hardening as the user avatar. No new environment variables | N/A | N/A (Settings → Organization → General → Workspace avatar; the shared workspace switcher shows every authorized UOA picture under its organisation) | read: current workspace actor or signed-in member of the requested team; write: organisation owner/admin | no | no | implemented (REST admin surface) |
| workspace roster (UOA) | `GET /api/workspace/members` — the people in the actor's UOA workspace, joined live from UOA `GET /org/organisations/{externalOrgId}/teams/{externalTeamId}` (team roles) and `GET /org/organisations/{externalOrgId}/members?status=all` (names, emails, lifecycle status). Nothing is persisted: UOA owns human identity and membership. Members are named by their **UOA subject**, never a local user id or an email row. Calls run in UOA **signed-subject mode** — the domain-hash bearer plus an `X-UOA-Subject-Assertion` carrying a one-minute RS256 assertion of the signed-in UOA subject and their exact active org/team (UOA §4.6c), which UOA verifies through Nessie's published config JWKS and then re-resolves the credential epoch and live membership before applying its own role gate and user audit attribution. `X-UOA-Access-Token` is never sent — Nessie holds no spendable user credential — and a caller with no current UOA session is refused `403 UOA_SESSION_REQUIRED` rather than falling back to the tenant-wide backend mode this used to rely on. A team with no `externalWorkspaceId`/`externalOrgId`, or a deployment without UOA, answers `404 WORKSPACE_NOT_LINKED` — there is never a fall back to local rows. No new environment variables | N/A | N/A (Settings → Organization → Members, on a UOA session) | any member of the workspace | no | no | implemented (REST admin surface) |
| workspace member avatar (UOA) | `GET /api/workspace/members/{uoaSub}/avatar` — the picture UOA holds for one person in the actor's workspace roster, relayed from UOA `GET /domain/users/{uoaSub}/avatar` with the domain-hash bearer. It exists because a roster row is named only by a UOA subject: the organisation-scoped relay `GET /api/users/{userId}/avatar` is keyed on a Nessie user id, and a roster member may have no local row at all. **The requested subject is checked against the workspace's own roster before any avatar call**, using the same `GET /api/workspace/members` read (briefly cached in-memory per workspace, ~30 s, so one page load asks UOA once rather than once per row) — without that check the full-trust domain-hash path would hand any member the picture of anybody in the whole UOA domain. A subject outside the roster and a subject UOA has no image for are the same cacheable `404 AVATAR_NOT_FOUND`, so nothing is learned about foreign subjects; an unlinked team or a deployment without UOA is `404 WORKSPACE_NOT_LINKED`; an unreadable roster is `502 UOA_DIRECTORY_UNAVAILABLE` and an unreachable avatar endpoint `502 UOA_AVATAR_UNAVAILABLE` — never a silent miss. Same relay hardening as the other avatar routes (content-type allowlist, `nosniff`, `content-security-policy: default-src 'none'`, `cache-control: private, max-age=300` on hit and miss alike). The roster renders it through the shared `UserAvatar`, falling back to initials. No new environment variables | N/A | N/A (Settings → Organization → Members, on a UOA session) | any member of the workspace (identical to the roster read) | no | no | implemented (REST admin surface) |
| workspace membership mutations (UOA) | `PUT /api/workspace/members/{uoaSub}/role` (`{role: admin\|member}` → UOA `PUT .../teams/{teamId}/members/{userId}` `{team_role}`), `DELETE /api/workspace/members/{uoaSub}` (UOA soft-remove + team session revocation), `POST /api/workspace/members/{uoaSub}/deactivate\|reactivate` (organisation-level in UOA; UOA refuses to deactivate an owner). **Backend mode has no acting user, so UOA applies no role check and records `actor_user_id: null` / `uoa_actor.via = domain_backend` — Nessie's owner/admin gate is the only authorization**, the same rule as the workspace avatar relay. Upstream 4xx → `WORKSPACE_MEMBERS_REJECTED`, transport/5xx/malformed body → `502 UOA_DIRECTORY_UNAVAILABLE` | N/A | N/A (Settings → Organization → Members) | organisation owner/admin | no | no | implemented (REST admin surface) |
| workspace invitations (UOA) | `GET /api/workspace/invitations` (UOA `GET .../teams/{teamId}/invitations`), `POST /api/workspace/invitations` (`{invites:[{email,name?,teamRole?}]}` → UOA's trusted-backend bulk invite; the response carries UOA's per-email verdict `invited\|resent_existing\|already_member\|existing_user\|conflict`), `POST /api/workspace/invitations/{inviteId}/resend` (refreshes UOA's 30-day expiry), `POST /api/workspace/invitations/{inviteId}/revoke` (withdraws an invitation that was already sent → UOA `DELETE .../teams/{teamId}/invitations/{inviteId}`; **idempotent** — revoking twice is still `200`, an invitation that has already been accepted is `409 INVITATION_ALREADY_ACCEPTED` because removing the member is a different decision, an unknown or foreign invite id is a generic `404`, and a `200` whose body is not `{ok:true}` is `502 UOA_DIRECTORY_UNAVAILABLE` rather than a silent revoke), `POST /api/workspace/invitations/{inviteId}/approve\|deny` (UOA's member-initiated-invite review queue; deny is the stop verb for an invitation that was never sent, revoke for one that was). **Acceptance is hosted by UOA**: Nessie never mints, stores, or renders an invitation token, and has no accept flow. Invite emails are PII, so the list is owner/admin only — matching UOA's own gate. Shareable invite links (`.../invite-links`) are deliberately not surfaced | N/A | N/A (Settings → Organization → Members → Invite to workspace / Pending invitations) | organisation owner/admin | no | no | implemented (REST admin surface) |
| agent avatar | `POST /api/agents` accepts an optional uploaded `avatarAttachmentId`; when omitted it creates a prompt from the agent's name/role/purpose and sends it through Ledger to OpenAI `gpt-image-2`, storing the resulting PNG through the standard FileService attachment path (local filesystem now, S3 when configured). New-user provisioning also bootstraps the organization-managed Personal Assistant's private DM and creates that assistant's first original, role-appropriate headshot; later users keep the established assistant avatar. A transient prompt/image failure never blocks account provisioning or sign-in; the next sign-in or PA bootstrap retries while no avatar is stored. `POST /api/agents/{agentId}/avatar/generate` creates a private preview, and the owner explicitly confirms it through `PATCH /api/agents/{agentId}/avatar`; uploads use `POST /api/uploads`. The generate body also accepts optional free-text `instructions` — the person's own description of the look they want ("a friendly robot in a hard hat") — which the prompt writer honours within the fixed safety constraints (single original subject, no text/logos, the exact pastel background); with no `instructions` the model defaults to a fictional human headshot, and selects a machine only where the role and purpose establish a non-human machine. Records expose both the attachment id and a persisted random pastel background colour, rendered behind every profile headshot. Editing an agent surfaces one avatar card whose pencil opens a single modal — a larger preview, an optional prompt with **Generate with AI**, **Upload** (crop), **Remove image**, and a top-right close — the same `AgentAvatarQuickEdit` the detail header uses. | N/A | N/A (Agents → open agent → Edit tab → avatar pencil → prompt + Generate with AI / Upload / Remove; Agents → New agent → Agent avatar; Direct messages → Personal Assistant) | creation: authenticated actor; generation/replacement: owner with exact-org agent visibility; attachment: actor-visible same-org image | no | no | implemented (REST admin surface; the avatar pencil is only rendered for owners, while the server repeats the owner check and shows an in-place spinner while generation is pending) |
| feedback | `GET/POST /api/feedback` (compose w/ optional attachment; mirrored to a GitHub issue when `NESSIE_GITHUB_TOKEN` is set) | `feedback.list`, `feedback.create` | N/A (Feedback section) | actor's own (org + user scoped) | no | yes | implemented (REST admin surface) |
| channel lifecycle | `POST /channels` | `project.channels.create`, `project.channels.update`, `project.channels.members.search` | `/channel create` | project/channel policy | yes | yes | blocked |
| agent catalog | `GET/POST /agents` | `agent.register`, `agent.update`, `agent.retire`, `agent.restore`, `agent.delete`, `agent.bind`, `agent.unbind` | `/agent register` | project/team/channel policy | yes | yes | blocked |
| tool catalog | `POST /tools` | `tool.import`, `tool.update`, `tool.bind`, `tool.unbind` | `/tool import` | project + transport policy | yes | yes | blocked |
| role binding | `POST /roles` | `role.assign`, `role.revoke` | `/role assign` | admin-role policy | yes | yes | blocked |
| channel membership | `POST /channels/{channelId}/members` | `channel.member.add`, `channel.member.remove` | `/channel member add` | channel policy | yes | yes | blocked |
| session tools | `POST /sessions/{action}` | `session.start`, `session.read`, `session.send`, `session.interrupt`, `session.status`, `session.close` | `/session start`, `/session send` | project + channel + tool policy | yes for long-running/privileged | yes | blocked |
| policy operations | `GET /policy/effective`, `.../preview`, `.../apply` | `policy.effective`, `policy.preview`, `policy.apply` | `/policy effective` | admin policy | yes | yes | blocked |
| secret operations | `POST /secrets` | `secrets.create`, `secrets.update`, `secrets.rotate`, `secrets.revoke`, `secrets.delete`, `secrets.resolve`, `secrets.access_check` | `/secret create` | secret + project/team/channel policy | resolve/rotate/revoke/delete: yes | yes | blocked |
| project safety | `POST /projects/{projectId}/safety/preflight`, `.../degrade`, `.../restore`, `.../archive`, `.../restore`, `.../delete` | `project.safety.preflight`, `project.safety.degrade`, `project.safety.restore`, `project.archive`, `project.delete` | `/project safety` | governance + project-state policy | yes | yes | blocked |
| step-up verification | `POST /verification/challenges/*`, `GET/POST /verification/factors*` | `verification.challenge.start`, `verification.challenge.verify`, `verification.challenge.resend`, `verification.challenge.cancel`, `verification.factor.enroll`, `verification.factor.verify`, `verification.factor.revoke`, `verification.factor.list` | `/verify`, `/verify enroll` | high-risk action policy | conditional | yes | blocked |
| language + translation | `GET/PATCH /orgs/{orgId}/language`, `GET/PATCH /users/{userId}/language`, `PATCH /threads/{threadId}/language`, `PATCH /sessions/{sessionId}/language`, `POST /translation/preview` | `translation.org.get`, `translation.org.update`, `translation.user.get`, `translation.user.update`, `translation.thread.update`, `translation.session.update`, `translation.preview` | `/language set`, `/translate preview` | org/user/thread/session policy | org default change: yes | yes | blocked |
| customer commercial billing and credits surface | `GET /api/billing/credits`, `GET /api/billing/recurring-addons`, manager-only credit top-up/automatic-top-up and recurring-add-on mutation routes, `GET /api/billing/statement`, `POST /api/billing/actions/upgrade`, `POST /api/billing/actions/portal`, `POST /api/billing/cancellation/preview`, `POST /api/billing/cancellation/confirm`; direct SSO exchange internally calls UOA `/billing/v1/service-access/confirm` | N/A | Credits & billing (`/tokens`) | credit/add-on reads: every active-team member; statement and mutations: active-team owner/admin; exact UOA workspace and UOA membership/manager re-check | every commercial mutation is a frozen UOA action: yes | yes | implemented (Nessie has no tariff, rating, credit balance, payment, top-up, add-on, statement, or cancellation-decision state. A dedicated UOA app key plus fresh 45-second RS256 actor assertion fetches UOA's display-ready models. The UI puts remaining credits first, then pending/added/used credits, service/user usage, recent activity, and automatic top-up state; 1,000 credits equal US$1. Managers receive payment controls and named-user detail, while members receive a privacy-safe read-only projection. The same selected-team balance is shared across products. Nessie performs no billing, credit conversion, aggregation, or share calculations. Frozen actions are fixed-allowlisted and proxied with UOA's exact body/token/idempotency key/choice; UOA alone checks authority, direct access, and indirect Ledger use. The page contains no Nessie-local cost, pricing, projection, token, connector, file, or budget panel; those owner-only operational controls live at `/ops/usage`. Direct-access evidence is recorded only after a successful direct Nessie SSO exchange and before local session issuance; UOA confirmation failure blocks login, while connector/agent/DeepWater paths never record it.) |
| builtin web search metering | Ledger `POST /v1/serper/search` | `web_search` | Agent and workflow tool execution | agent tool grant/policy; exact signed user/org/team/agent/run/tool-call provenance | no | yes | implemented (Nessie's product-bound Ledger key authenticates the app; Ledger injects Serper credentials and owns raw search metering. Agent, delegated sub-agent, and workflow paths fail closed without signing identity and have no direct Serper-key fallback. Nessie connector rows are operational telemetry only.) |
| token, connector, and file usage ledger + pricing | `GET /api/ledger/tokens/summary`, `GET /api/ledger/connectors/summary`, `GET /api/ledger/files/summary`, `GET /api/ledger/runs/timing`, `GET /api/ledger/tokens/by-outcome`, `GET/POST /api/ledger/tokens/pricing`, `DELETE /api/ledger/tokens/pricing/{profileId}`, `GET /api/ledger/tokens/monthly-estimate` | `ledger.tokens.summary.get`, `ledger.connectors.summary.get`, `ledger.files.summary.get`, `ledger.runs.timing.get`, `ledger.tokens.by_outcome.get`, `ledger.tokens.pricing.list`, `ledger.tokens.pricing.upsert`, `ledger.tokens.pricing.delete`, `ledger.tokens.monthly_estimate.get` | owner-only Operational usage (`/ops/usage`); `/ledger tokens`, `/ledger pricing` | owner policy; pricing override is owner-only | pricing override: yes | yes | implemented-partial (REST admin surface; file summary reports current stored bytes plus upload/download transfer bytes; `runs/timing` returns recent per-run wall-clock stage latency from worker `run.timing` events — queue wait / inference / tool, no cost; `tokens/by-outcome` splits local token spend by run outcome (completed/failed/cancelled/…) so failed-run spend is attributable; the budget gate also pushes once-per-period threshold/blocked alerts to owners + scope managers (`budget.alert-dispatch`); local operational calculations are visually and navigationally separate from Credits & billing) |
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
- The admin channel feed renders every human and agent post as safe
  GitHub-flavoured Markdown, including inline backtick code and fenced code
  blocks. Triple-backtick blocks may begin within a chat line and preserve
  their internal newlines. A fence the author never closed is closed at render
  time, so a chat line such as ` ```is it done? ` posts as a code block
  containing those words instead of an empty block; a lone language tag on the
  opening line still reads as a language.
- The composer and message editor style code ranges live and conceal the
  backticks once a delimiter pair wraps something, so the snippet reads the way
  it will post. An empty pair keeps its backticks visible. A concealed
  delimiter is atomic: one arrow press crosses it, one delete removes it whole,
  and typing beside it stays outside the snippet. Shift+Enter inserts a soft
  line break at the caret, inside a code block or in prose. Mentions remain
  interactive in prose and stay literal inside code.
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
  - [agent-tool-capabilities](./agent-tool-capabilities/01-foundations.md),
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
  - interactive session schema: [agent-tool-capabilities](./agent-tool-capabilities/04-interactive-tools.md).

## 13.4) Knowledge base linking and retrieval requirements (no context pollution)

- Phase B first-party authoring is available under `/api/knowledge-base/*`:
  - spaces: list/create/read/update/archive,
  - pages: tree/create/read/update/archive/move/publish,
  - versions: list/restore-as-new-version,
  - search: `POST /api/knowledge-base/search` — `mode: 'keyword'` (trigram
    title/summary/label match) or `mode: 'hybrid'` (default with query text;
    tsvector + pgvector RRF over page-body chunks, returns matched passages
    with offsets). Access is enforced in SQL via a readable-spaces pre-filter.
    Chunk embeddings are filled asynchronously by the worker `knowledge.embed`
    queue job (incremental by content hash, batched, ledger-billed). Optional
    `taskId` filter restricts hits to a ticket's documents.
  - summary: `POST /api/knowledge-base/search-summary` — opt-in bounded cited
    synthesis over the top hybrid chunks (≤8 chunks, one ledger-attributed
    completion call, zod-validated citations, no model call on zero matches).
  - links: version saves maintain `knowledge_page_links` from `[[wikilink]]`
    anchors; `GET /pages/:id/backlinks` and `/mentions` serve the ACL-filtered
    reverse index. Unresolved `[[Title]]` links auto-resolve when a matching
    page is created or renamed.
  - ticket docs: `POST /api/knowledge-base/my-docs` (personal space ensure),
    `GET/POST /api/knowledge-base/tasks/:taskId/pages` and `POST .../files` —
    ticket documents live in an auto-provisioned per-project
    "Project Documents" space under a per-ticket folder, carry `taskId`
    through pages and chunks, and surface in the ticket dialog's Documents
    section.
  - file extraction: file-node uploads/versions enqueue `knowledge.extract`
    (text/code, PDF, DOCX; 20 MiB / 500k-char caps; bytes via FileService
    only) which chunks the extracted text and feeds the same embed pipeline —
    uploads are hybrid-searchable with zero LLM calls in the path.
- Every first-party search/read response carries `sourceRef`, `visibilityReason`, and `policyChainTrace`.
- Agent-facing retrieval tools are implemented: builtin `kb_search` /
  `kb_page_read` / `kb_list` (read-only, ACL-checked per call, no bypass for
  agents) plus a per-organization, system-managed **Librarian** agent seeded
  via `POST /api/knowledge-base/librarian` (`ensureLibrarianAgent`). See
  [knowledge-base-requirements.md §9d](./knowledge-base-requirements.md#9d-retrieval-tools--librarian-agent-implemented-read-path)
  for the tool contract and
  [plans/2026-07-06-documents-rag-redesign.md](./plans/2026-07-06-documents-rag-redesign.md)
  §6 for the full Librarian design (write/publish path is Phase 3, not yet built).
- Knowledge sources must be importable as a first-class tool action in the later external facade tier:
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
  - one-file tool family definition patterns: [agent-tool-capabilities](./agent-tool-capabilities/02-checkbox-ui-api.md).

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
  - [external-tool-integration.md § Remote MCP Servers](./external-tool-integration.md#remote-mcp-servers-self-hosted-runners),
  - [organization-governance-spec.md](./organization-governance-spec.md),
  - [agent-tool-capabilities](./agent-tool-capabilities/04-interactive-tools.md).

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
  - [deployment-modes-and-auth-spec/overview.md](./deployment-modes-and-auth-spec/overview.md).

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
  - policy chain: org -> project -> team -> channel -> explicit secret bindings, deny-first at each layer. (That order follows the schema's current `Team.projectId` direction, which is inverted relative to the model in `docs/standards/workspace-model.md`; it is the resolution order the code uses today, not the hierarchy.)
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

#### Inbound webhook intake (agent-level webhook triggers)

Agent-level `webhook` triggers receive inbound calls on the public API:

- **Bearer-key intake** — `POST /api/triggers/webhook`. The request carries the
  trigger's `apiKey` via `Authorization: Bearer <key>` or `X-Nessie-Trigger-Key`;
  the server matches it (timing-safe) against active `webhook` triggers. Triggers
  that have a `signingSecret` set are excluded from this path.
- **HMAC-signed intake** — `POST /api/triggers/{triggerId}/webhook`. Used when the
  trigger has a `signingSecret`. The caller sends `X-Nessie-Signature` containing
  the hex HMAC-SHA256 of the raw request body (a `sha256=` prefix is accepted,
  GitHub-style); the server verifies it timing-safe against the trigger's secret
  and rejects mismatches/missing signatures with `401`.

Both paths dedupe on `X-Nessie-Delivery-Id` / `X-Github-Delivery` / `X-Request-Id`.
A dispatch that fails transiently is recorded as a `failed` delivery with
`retry_count` / `next_retry_at`; the worker retry poller re-attempts due
deliveries with exponential backoff (30s × 2^n, capped at 30 min, up to 5 retries)
before exhausting them.

#### What a trigger fire looks like in the channel

A fire creates a kickoff `Message` that drives the run, and the agent then
answers. Two structural facts govern how that reads to a person:

- **The kickoff is `role: 'system'`.** It is an internal directive — generated
  text like `Trigger fired: interval (source: scheduler).` plus the payload
  JSON, or an operator's saved prompt plus the memory nudge — so it is
  excluded from the channel feed and from later model context, while the row
  itself persists for audit and for restart replay (which loads it by id and
  never checks role). The run still receives it as its prompt through
  `payload.messageId`. Rendering it as a `user` message previously attributed
  it to the trigger's owner, who wrote none of it, and filled monitoring
  channels with plumbing. Human-facing provenance is the Triggers page
  delivery log.
- **The run is stamped `replyPlacement: 'channel'`.** A trigger fire is a
  standalone contribution to the room, not an answer owed to the kickoff, so
  the agent posts top-level where an alert belongs. Stamped structurally from
  the fact that it is a trigger run — never judged from message content.

#### When a scheduled run fails, the channel does not hear about it

An interactive turn that fails posts the error, because a person is waiting for
an answer. An unattended run — schedule, interval, webhook — does not: nobody
asked, and a broken integration would otherwise turn its own alert channel into
a repeating apology (a 15-minute sweep that could not reach its provider wrote
the same "I could not complete that request" four times an hour, burying the
findings the channel existed for).

The failure is not hidden, it is moved to where the owner looks: the run is
`failed`, the worker logs it, and the Triggers page delivery row now shows the
**run's** outcome next to the delivery's. Those are different questions — a
fire that dispatched fine and then failed mid-run still reads
`status: 'delivered'`, which is why a red "run failed" chip had to be added
before the channel message could be taken away.

#### Giving a recurring schedule an end

A recurring trigger (interval or cron) may carry `until` in its config — an
ISO-8601 instant after which it stops. This is the shape of a temporary watch:
an incident window, a migration, an overnight soak. Without it every schedule
ran forever and had to be remembered and paused by hand.

Enforcement reuses the existing stop signal rather than adding one: a computed
fire time past `until` becomes `null`, which clears `next_run_at`, and the
scheduler only claims rows where that column is set
(`parseScheduleUntil` + the `withinScheduleEnd` guard in
`packages/runtime/src/scheduling.ts`). The API's own arming path
(`normalizeNextRunAt`, `api/src/services/trigger-shared.ts`) applies the same
guard, because it does not go through the worker's initial-arm function — a
schedule submitted with an end already past must not arm and fire once.

A lapsed recurring trigger is set to **paused**, not left `active` with no next
run, which would be a zombie indistinguishable from a broken config. Pause is
already the product's reversible stop state, so resuming works — and
`resumeAgentTrigger` re-arms a scheduler-type trigger whose `next_run_at` is
null, or leaves it paused when the end is still in the past. A malformed
`until` reads as "no end" so a bad value can never silently stop a schedule.
Set it in the trigger editor's optional **Stop after** field.

These two are one change and must stay paired: a hidden kickoff with the
default thread placement would anchor every reply under an invisible root and
drop it out of the feed. Both the direct claim path
(`worker/src/control/trigger-run.ts`), the API webhook-intake path
(`api/src/services/trigger-dispatch.ts`), and the batched pending-drain path
(`packages/db/src/thread-serialization.ts`, which derives placement from the
pending row's `triggerId`) apply them.

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
- No trigger scheduler for `scheduled`, `webhook`, or `event` trigger subtypes on workflows. Agent-level triggers are specified in the-agents.md § 17 but not yet implemented.
- User status contact rules are persisted and editable in `/settings/statuses`, but inbound message dispatch does not yet evaluate them to start response agents.
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

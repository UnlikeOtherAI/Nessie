# Agent Communication Model (Slack-Style Routing)

> Status: target-state design.

## 1) Goal

Create a messaging model where users can:
- message any agent directly,
- message a channel of agents,
- message an organizer/dispatcher (hidden from direct chatter unless requested),
- still keep multi-level sub-agents alive, and
- prevent all agents from responding at once.

The organizer is the default decision layer. It receives every message, chooses who should answer, and injects replies back into the same thread.

## 2) Core entities

### 2.1 Thread

A thread is a conversational container with metadata:
- `threadId`: stable route key,
- `visibility`: `user-visible` or `internal`,
- `routingMode`: `single`, `broadcast`, or `opinion`,
- `scope`: one of `web`, `mcp`, `operator`, or future transports,
- `context`: bounded set of pinned messages, latest state, active agent set, current `projectId`, canonical language, and optional per-viewer delivery language.

### 2.2 Agent

Every agent object includes:
- `id`, `name`, `role`, `status`,
- `promptProfile`, `toolPolicy`, `sandboxPolicy`,
- `channelId`, optional `parentAgentId`,
- `subAgents` (IDs of children it can spawn/manage).

### 2.2a Agent status model

Every agent has exactly one status at any time. Status transitions are server-authoritative and pushed to clients via the canonical realtime event catalog. Phase 1 delivers these over WebSocket.

Statuses:

| Status | Meaning | Visual indicator |
| --- | --- | --- |
| `idle` | Agent exists, no active work | dim/grey dot |
| `thinking` | Agent is processing, model call in flight | pulsing/breathing dot |
| `executing` | Agent is running a tool | animated/spinning dot |
| `waiting_approval` | Agent hit an approval gate and is blocked | amber/yellow dot |
| `error` | Agent's last run failed | red dot |
| `offline` | Agent is registered but not reachable (remote worker down, etc.) | hollow/outline dot |

Transition rules:

- `idle` -> `thinking` when a run starts
- `thinking` -> `executing` when the agent calls a tool
- `executing` -> `thinking` when tool completes and agent resumes reasoning
- `thinking` -> `idle` when run completes successfully
- `thinking` -> `waiting_approval` when approval gate is reached
- `waiting_approval` -> `thinking` when approval is granted
- `waiting_approval` -> `idle` when approval is rejected (run cancelled)
- any -> `error` on unrecoverable failure
- `error` -> `idle` when error is acknowledged or next run starts

Every status transition emits an `agent.status` realtime event within 500ms. The UI must never show stale status.

### 2.2b Agent activity context

When an agent is not idle, the server must track and expose:

- `currentRunId`: the active run
- `currentToolName`: if executing, which tool (null if thinking)
- `currentToolStartedAt`: when the current tool call started
- `activeSubAgents`: list of `{ agentId, status, taskId }` for spawned children
- `lastActivityAt`: timestamp of most recent status change

This context is returned by `GET /api/agents/{agentId}/status` and included in `agent.status` realtime events so the UI can show what the agent is doing without additional requests.

### 2.2c Last messages contract

Every agent must expose its most recent messages through a dedicated endpoint: `GET /api/agents/{agentId}/messages?limit=5`.

This endpoint returns the last N messages (default 5) that the agent sent or received, ordered newest-first. The result includes:

- `messageId`, `role` (user/assistant/system), `content` (truncated to 500 chars for preview), `fullContent` (complete), `threadId`, `timestamp`

The `/admin` UI must display these messages in the agent detail view without requiring the user to navigate to the thread. This is not optional — the last 5 messages are always visible when viewing an agent.

When a new message arrives for a subscribed agent, the realtime layer pushes a `message.new` event with `{ agentId, messageId, role, contentPreview, threadId }` so the UI can update the message list without polling.

### 2.3 Channel

A channel is a named audience with policy:
- `id` and `label`,
- `organizationId` and `teamId`,
- default responder profile,
- allowed tools from role/agent policy,
- visibility policy (`public`, `protected`, `private`),
- read vs write split permissions,
- whether silent routing is required.

### 2.4 Organization/Team

- `Organization` is the top-level trust boundary.
- `Organization` is the top-level container; teams, channels, agents, and their policies all resolve inside one organization scope.
- `Team` is a security and policy boundary under an organization.
- Team policy controls:
  - user membership and invitations,
- default channel visibility,
  - agent/tool baseline access,
  - elevated actions (`review`, `approve`, `admin`).
- Agents can be:
  - team-owned (default to one team),
  - shared (explicitly granted to additional teams),
- restricted (invite-only override inside team/channel).

### 2.5 Membership bindings

Routing and tool execution must validate:
- actor -> teams,
- actor -> channels,
- actor -> roles,
- required role/action pairs.

Missing bindings must be treated as deny with explicit audit reason.

### 2.6 Routing organizer (hidden organizer)

For every parent conversation scope, create one hidden organizer role:
- receives all inbound messages for that scope,
- can observe direct mentions,
- runs routing and confidence scoring,
- returns exactly one visible agent response unless user explicitly asks for multiple views,
- can spawn or re-route to sub-agents.
- can also act as the stable aggregation agent for multi-pass execution pipelines.

## 3) Message address model

Users can address:
- one agent: `@coder`, `ask reviewer: ...`
- one channel: `@ops`, `@research`.
- everyone with permission: `@all`, `@channel` (explicit broadcast only)
- organizer directly only when explicitly configured.

Multiple explicit mentions:
- `@agent1 @agent2 ...` means explicit multi-agent selection.
- default outcome is only those tagged agents + organizer synthesis of their responses.
- untagged agents are not considered in this explicit mode unless fallback routing triggers.

### 3.0a Language normalization and translated delivery

- the canonical thread record is stored in the organization default language.
- users may read/write through translated delivery in their preferred language.
- inbound user messages should be normalized into canonical organization language before routing and persistence.
- outbound visible messages may be translated per recipient after responder selection.
- translated copies are view-layer artifacts; the thread history remains canonical in the organization language.
- if a user changes their preferred language or says "I want all communication in Turkish", that affects delivery for that user and does not rewrite stored history.
- translation should use a bounded thread context window by default:
  - current message plus up to 2 previous messages from the same thread,
  - participant pronoun/profile hints when available,
  - trimmed by policy/token budget,
  - enough to preserve subject matter and terminology without exposing the full thread.

### 3.1 Default routing path

When no explicit mention is present, organizer runs this sequence:
1. infer intent and required role,
2. compute candidate set from active channel policies,
3. score candidates by policy fit, load, tool availability, and recent quality,
4. choose exactly one responder for silent mode,
5. attach a compact rationale with confidence score to thread state.

### 3.2 Explicit multi-agent mode

User can force multiple perspectives with command patterns:
- `all viewpoints: ...`
- `ask everyone for perspective on ...`
- `broadcast to channel ...`
- multi-tag mentions in one message (`@agentA @agentB`)

In this mode, organizer returns one merged synthesis by default plus per-agent short notes in a hidden metadata slot. If a user sets `show all`, the UI can reveal all raw perspectives.

### 3.3 Parallel findings aggregation

When a task fans out into parallel runs, the hidden organizer may also act as the orchestrator aggregation pass:
- collect all candidate outputs and evaluation metadata,
- score, rank, or vote on those outputs using deterministic policy,
- emit the single selected result for the next loop stage,
- persist rejected candidates in the task ledger without surfacing them by default.

This must work the same way whether the candidates came from:
- the same agent run multiple times,
- multiple tagged agents,
- sub-agents launched under one parent,
- a mixed provider pool.

If the execution policy declares a fixed orchestrator, the same orchestrator identity should perform every aggregation pass for that pipeline unless a stage explicitly opts out.
This aggregation path should only be active when the execution policy explicitly enables `orchestrator.collectAllFindings`; the canonical execution-pipeline shape lives in [01-foundations.md](./agent%20tool%20capabilities/01-foundations.md).

## 4) Sub-agents and depth

Each agent can have children (“three-level deep” and beyond in architecture):
- `childAgentIds` and `parentAgentId` are explicit,
- all routing and spawning should honor depth caps,
- every child can have sub-agents,
- all agents can still be messaged directly by name.

Depth policy:
- hidden organizer must keep context to current depth + lineage,
- parent can revoke child delegation,
- parent may ask child to query deeper children and return only summary + citations.

## 5) Non-overlap behavior (silent default)

To avoid chaos:
- if target is implicit and not explicitly broadcast, only one answer appears.
- if target is explicit (`@agent` or `@channel`) only that receiver is visible to user unless escalation policy allows fallback.
- organizer may still precompute private opinions and drop low-confidence candidates.

A thread can still show a separate `routing.trace` field for audit/debug, not the full text from every agent.

## 6) Tooling integration requirements for this routing model

Every tool operation should carry structured execution context:
- `agentId`, `channelId`, `threadId`, `projectId`, `callerAgentId`,
- resolved `policySource` (`role`, `agent-override`, `task-override`),
- `sandboxId` and policy reference.

Tool use requires:
- policy check first,
- merged grant + sandbox resolution,
- action-level log with selected source and confidence.

Tool families this model expects:
- command tools (one-shot and interactive),
- API/HTTP tools,
- MCP/remote tools,
- file and DB tools,
- DB-less helper tools for summarization/routing.
- translation/normalization services for multilingual delivery when enabled by policy.

Command tool expectations for your current examples:
- support generic CLI wrappers where tool config is free-form JSON:
  - `codex` shell invocation and `claude` invocation,
  - support discovery commands like `claude -h` / `claude --help` to capture supported model flags,
  - preserve full tool config as `Record<string, unknown>` so a tool family can add new keys without schema lock-in.

Interactive sessions are part of this model because organizer/sub-agents need conversational context over time (`session:start`, `session:send`, `session:read`, `session:interrupt`, `session:status`, `session:close`).

Sessions must capture actor and team context so they can be revoked when memberships change.

## 7) Search and context control

The UI and organizers should avoid loading full registries each session.
Required query surface:
- `agents/search`
- `channels/search`
- `tools/search`
- `tools/tags`
- `agents/{agentId}/capabilities`

Org-aware filters required:
- `orgId`, `teamId`, `scope`,
- `includePrivate`, `includeProtected`,
- `visibility`,
- `canRead` / `canInvoke` / `canManage`.

This is mandatory to keep context stable, especially when hidden organizers and long threads are active.

## 8) Security and permissions baseline

- Organizers are not global superusers unless explicitly assigned,
- no channel or agent can access tools outside its policy,
- all interactive sessions must have read/write/file/network restrictions,
- every tool/agent action should include allow/deny logs.

Access evaluation baseline:
- evaluate `organization -> team -> channel -> agent -> tool` in sequence,
- explicit deny always wins over allow,
- channel membership and role bindings are checked before routing and before tool invocation.

## 9) Current implementation status (Nessie as-of-2026-04-07)

- `@agent` mention routing: **partial** (`resolveExplicitTargetAgent` on known on-demand agents).
- channel model: **not implemented**.
- hidden organizer: **partially exists as `main` behavior**, but not a structured silent dispatcher.
- stable orchestrator aggregation across parallel execution passes: **not implemented**.
- one-agent-at-a-time default for implicit messages: **not explicit**; current behavior often sends to `main` with ad-hoc subagent triggers.
- nested agent messaging: **only static on-demand + spawned tasks**, no stable multi-level direct addressing.
- tool policy inheritance/prompt inheritance: **planned, not implemented**.
- interactive process tools: **not implemented**.
- tool/agent search endpoints: **not implemented**.
- organization/team membership ACL: **not implemented**.
- organization scoped visibility model (`public`/`protected`/`private`): **not implemented**.
- access-deny audit reasons and policy trace: **not implemented**.

## 10) Migration steps for implementation

1. Add `channels`, `agentChannels`, and `routingDecision` to orchestrator state.
2. Add resolver service for message addressing and ranking.
3. Add organizer route events (`routing.started`, `routing.chosen`, `routing.trace`).
4. Add silent opinion mode + explicit `broadcast` flag.
5. Add `session:*` tool family and PTY transport.
6. Add deterministic `/agents/search`, `/channels/search`, `/tools/search`.
7. Wire role/agent policy + sandbox policy into tool invocation and sub-agent spawn paths.
8. Add organization/team policy model and bindings (`Organization`, `Team`, `TeamMembership`, `ChannelMembership`).
9. Add `/access/check` and organization-aware filters on all search endpoints.
10. Add deny-reason capture in routing traces (`policySource`, `bindingMissing`, `scopeMismatch`).

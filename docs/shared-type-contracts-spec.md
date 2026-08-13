# Shared Type Contracts

> Status: active target-state design.

## 1) Canonical package

Create one shared package:

- `packages/schemas`

Every service and frontend app must import shared contracts from here.

That includes:

- `/api`
- `/admin`
- `/worker`
- `/runner`
- shared domain packages

This package is the single source of truth for:

- API envelopes
- pagination contracts
- realtime event catalog
- branded entity IDs
- actor/action context
- Zod validation schemas

## 2) API envelope

Use one success shape and one error shape everywhere.

```ts
type ApiResponse<T> = {
  data: T;
  meta?: PaginationMeta;
};

type ApiError = {
  error: {
    code: string;
    message: string;
    field?: string;
    details?: unknown;
  };
};
```

Rules:

- `code` is machine-readable
- `message` is human-readable
- `details` must never include secrets
- every HTTP handler and frontend client should assume this envelope

## 3) Pagination

Use one cursor pagination contract everywhere.

```ts
type PaginationParams = {
  cursor?: string;
  limit?: number;
  direction?: 'forward' | 'backward';
};

type PaginationMeta = {
  cursor: string | null;
  total?: number;
  hasMore: boolean;
};
```

Rules:

- default `limit = 50`
- maximum `limit = 200`
- cursor is opaque
- cursor should be derived from a stable `(updatedAt, id)` boundary
- do not introduce offset pagination for new endpoints

## 4) Realtime event catalog

Realtime event names must come from one typed catalog. This is the single source of truth. Other documents must reference this catalog, not redefine event shapes inline.

Every event has a transport annotation:

- `sse` — delivered over SSE only (chat/thread streaming)
- `ws` — delivered over WebSocket only (presence/activity)
- `both` — delivered over both transports

```ts
type AgentStatus = 'idle' | 'thinking' | 'executing' | 'waiting_approval' | 'error' | 'offline';

type RunStatus = 'pending' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled';

type TaskStatus = 'inbox' | 'assigned' | 'in_progress' | 'review' | 'done' | 'failed' | 'cancelled' | 'awaiting_approval';

// SSE events — chat/thread streaming
type SseEventMap = {
  // rootMessageId is the run's resolved reply anchor (null = top-level), so a
  // client can place the live thinking surface where the reply will land.
  'stream.start': {
    runId: string;
    threadId: string;
    agentId: string;
    rootMessageId?: string | null;
  };
  // chunkId is the durable RunThinkingChunk id (BigInt serialized as a string),
  // present when the chunk was persisted; clients dedupe live events against the
  // REST thought log with it.
  'stream.reasoning': { runId: string; content: string; chunkId?: string };
  // One tool line of the thought process: `toolName: inputSummary`.
  'stream.thinking.tool': { runId: string; content: string; chunkId?: string };
  'stream.delta': { runId: string; content: string };
  'stream.done': {
    runId: string;
    messageId: string;
    agentId?: string;
    content?: string;
    createdAt?: string;
    rootMessageId?: string;
  };
};

// WebSocket events — presence and agent activity
type WsEventMap = {
  'agent.status': {
    agentId: string;
    status: AgentStatus;
    since: string;
    currentRunId?: string;
    currentToolName?: string;
    currentToolStartedAt?: string;
  };
  'agent.tool.start': {
    agentId: string;
    runId: string;
    toolName: string;
    inputSummary: string;
  };
  'agent.tool.end': {
    agentId: string;
    runId: string;
    toolName: string;
    durationMs: number;
    success: boolean;
  };
  'agent.spawned': { parentId: string; childId: string; taskId: string };
  'run.updated': { runId: string; agentId: string; status: RunStatus };
  'task.updated': { taskId: string; status: TaskStatus };
  'approval.needed': {
    taskId: string;
    approvalId: string;
    agentId: string;
    action: string;
    reason: string;
  };
  'approval.resolved': {
    approvalId: string;
    taskId: string;
    agentId: string;
    outcome: 'approved' | 'rejected' | 'expired';
    resolverId?: string;
    resolvedAt: string;
  };
  'message.new': {
    agentId: string;
    messageId: string;
    role: 'user' | 'assistant' | 'system';
    contentPreview: string;
    threadId: string;
  };
};

// Phase 2 events — listed in WsEventMap for type completeness, not implemented in Phase 1
//
// agent.thought:        wired in Phase 2 (stub component exists in Phase 1)
// agent.tool.progress:  wired in Phase 2
// approval.resolved:    Phase 2 (approval-gating-spec.md)
```

Rules:

- use dot-separated names only
- SSE events go on `SseEventMap`, WebSocket events go on `WsEventMap`
- **do not put chat streaming events on the WebSocket**
- **do not put agent activity events on SSE**
- `stream.reasoning` is for provider-supplied chat reasoning/thinking text only; it is scoped to the active thread stream and is separate from Phase 2 `agent.thought` activity events
- `stream.reasoning` and `stream.thinking.tool` are published by the worker's per-run thought recorder, one event per coalesced flush (not one per provider token); each carries the id of the `run_thinking_chunks` row it persisted
- `stream.*` events are never replayed from the SSE backlog. A client that joined mid-run recovers the thinking state over REST (`GET /api/threads/:threadId/thinking`) and merges it with live events by `chunkId`
- `message.new` is a WebSocket event for cache invalidation; the actual message content arrives via SSE `stream.done` or REST query — not duplicated on both transports
- legacy event names (`streaming.start`, `subagent.started`, `task.state_changed`) are historical only and must not be used for new `/api` or `/admin` work
- `agent.thought`, `agent.tool.progress`, and `approval.resolved` are Phase 2 events; do not implement in Phase 1
- `waiting_approval` is a valid `RunStatus` from Phase 1 for display; the approval resolution mechanism (endpoint to approve/reject, `approval.resolved` event) is Phase 2 — see [approval-gating-spec.md](./approval-gating-spec.md); in Phase 1, `waiting_approval` is display-only
- `offline` status applies to remote-worker-backed agents (Phase 4); Phase 1 agents never emit `offline` but the type includes it so the frontend stub renders correctly when the status is added later

## 5) Realtime replay and reconnection

SSE reconnect must use:

- `Last-Event-ID`
- a monotonic sequence per stream

Rules:

- sequence must map to durable state in Postgres
- reconnect should replay from durable events
- frontend should resume from sequence, not infer missing state from wall-clock time
- do not use timestamps as the replay cursor

WebSocket reconnect rules:

- the client reconnects with its subscription set
- the server replies with a current snapshot for subscribed entities, then resumes live events
- WebSocket reconnect must not depend on instance-local memory
- if durable replay is added for a WebSocket event family later, it must still use the same monotonic sequence strategy

### WebSocket subscription protocol

The WebSocket at `WS /api/activity` uses a simple JSON message protocol. All messages are JSON objects with a `type` field.

Client-to-server messages:

```ts
// Subscribe to agent activity for specific scopes
type WsSubscribe = {
  type: 'subscribe';
  scopes: Array<
    | { kind: 'organization'; organizationId: string }
    | { kind: 'channel'; channelId: string }
    | { kind: 'agent'; agentId: string }
  >;
};

// Replace current subscriptions entirely
type WsSetSubscriptions = {
  type: 'set_subscriptions';
  scopes: WsSubscribe['scopes'];
};

// Remove specific subscriptions
type WsUnsubscribe = {
  type: 'unsubscribe';
  scopes: WsSubscribe['scopes'];
};

// Keepalive
type WsPing = { type: 'ping' };
```

Server-to-client messages:

```ts
// Subscription confirmed
type WsSubscribed = {
  type: 'subscribed';
  scopes: WsSubscribe['scopes'];
  snapshot: WsSnapshot;
};

// Current state snapshot (sent on subscribe and reconnect)
type WsSnapshot = {
  agents: Array<{
    agentId: string;
    status: AgentStatus;
    since: string;
    currentRunId?: string;
    currentToolName?: string;
    currentToolStartedAt?: string;
  }>;
};

// Live event delivery
type WsEvent = {
  type: 'event';
  event: keyof WsEventMap;
  data: WsEventMap[keyof WsEventMap];
  ts: string;
};

// Keepalive response
type WsPong = { type: 'pong'; ts: string };

// Error
type WsError = { type: 'error'; code: string; message: string };
```

Rules:

- the client must send `subscribe` or `set_subscriptions` after connecting; the server does not push events until a subscription exists
- `set_subscriptions` replaces all current subscriptions atomically; use this on reconnect
- `subscribe` and `unsubscribe` are additive/subtractive
- on `subscribe` or `set_subscriptions`, the server replies with `subscribed` including a `snapshot` of current agent states for the subscribed scopes
- after the snapshot, the server pushes live `event` messages as they occur
- the server sends `pong` in response to `ping`; clients should ping every 30 seconds
- if the JWT in the initial WebSocket upgrade request is expired, the server closes the connection with code `4001`
- if the WebSocket is idle for 60 seconds with no ping, the server may close with code `4002`

## 5.1) Auth/session response contract

`GET /api/auth/me` is the canonical source of truth for `/admin`.

It returns `ApiResponse<MeResponse>`.

```ts
type MeResponse = {
  user: {
    id: UserId;
    email: string;
    displayName: string;
    avatarUrl?: string;
    avatarAttachmentId?: string;
    gravatarUrl?: string;
    pronouns?: string[];  // e.g. ["she", "her"] or locale-specific forms
    roleIds: string[];
  };
  session: {
    sessionId: string;
    issuedAt: string;
    expiresAt?: string;
  };
  context: {
    organizationId: OrganizationId;
    projectId: ProjectId;
    teamId: TeamId;
    channelId?: ChannelId;
    bootstrapMode: boolean;
  };
  auth: {
    providerId: string;
    providerType: 'oidc' | 'saml' | 'uoa' | 'local-bootstrap' | 'custom';
    autoRedirectToSso: boolean;
  };
};
```

Rules:

- `/admin` must not reconstruct current identity from any second endpoint
- the same payload seeds `AuthSessionProvider` and the initial actor context used by `/api`
- follow-up endpoints may enrich data, but they must not contradict `MeResponse`
- avatar precedence is client-resolved as custom attachment, provider picture,
  Gravatar, then initials fallback

Phase 1 `channelId` rule:

- `context.channelId` is always `null` in Phase 1
- channel selection is a frontend routing concern, not a session concern
- the user picks a channel by navigating the channel list in `/admin`
- the active channel lives in React Router URL state (e.g. `/admin/channels/:channelId`), not in the session

## 5.2) User record contract

`GET /api/users` and `POST /api/users` return `ApiResponse<UserRecord[]>` and
`ApiResponse<UserRecord>` respectively.

```ts
type UserRecord = {
  id: UserId;
  email: string;
  displayName: string;
  role: string;
  channelIds: ChannelId[];
  activeStatus?: UserActiveStatus | null;
  avatarUrl?: string | null;
  avatarAttachmentId?: string | null;
  gravatarUrl?: string | null;
  createdAt: string;
  updatedAt: string;
};
```

Rules:

- `avatarAttachmentId` is a custom uploaded avatar served through attachments
- `avatarUrl` is the provider-supplied profile image
- `gravatarUrl` is derived from email and may 404 locally; clients must fall
  back to initials when no avatar image resolves
- when the user navigates to a channel, route handlers derive `channelId` from the URL path param and pass it into `actionContext`
- if "last active channel" persistence is added later (Phase 2+), it can populate `channelId` as a convenience hint — but the frontend must never treat it as mandatory

## 5.3) Agent record contract

`GET /api/agents`, `POST /api/agents`, `PUT /api/agents/{agentId}`, and
`PATCH /api/agents/{agentId}/avatar` return `ApiResponse<AgentRecord>` or
`ApiResponse<AgentRecord[]>` depending on the route. `POST
/api/agents/{agentId}/avatar/generate` returns a private replacement preview.

```ts
type AgentRecord = {
  id: AgentId;
  name: string;
  role: string;
  status: AgentStatus;
  agentKind: 'personal_assistant' | 'shared';
  systemManaged: boolean;
  surfacePolicy: 'dm_only' | 'shared';
  delegationMode: 'act_as_requesting_user' | 'none';
  avatarAttachmentId?: string | null;
  avatarBackgroundColor?: string;
  channelIds: ChannelId[];
  createdAt: string;
  updatedAt: string;
};
```

Rules:

- `avatarAttachmentId` is an uploaded or Ledger-generated image served through
  attachments; a generated preview remains private until an owner confirms it
  through the avatar PATCH route
- creating an agent without `avatarAttachmentId` generates a cartoon headshot
  through Ledger's OpenAI `gpt-image-2` endpoint; a text model first turns the
  agent's name, role, and purpose into the image prompt
- `avatarBackgroundColor` is a persisted random pastel from the fixed palette;
  it also sits behind transparent uploaded images and keeps every avatar surface
  visually consistent
- clients resolve the attachment when present and fall back to the generated agent glyph when absent or not yet loaded
- avatar uploads must use an attachment visible to the acting user in the same organization
- generic shared agents always belong to the active organization; list,
  hierarchy/status/activity/realtime reads, parents, and channel bind/unbind
  writes require that exact organization, while system/global agents use
  dedicated bootstrap paths

## 5.4) Favourite record contract

`GET /api/favorites` returns the signed-in user's favourites in the active
organization. `PUT /api/favorites/{targetType}/{targetId}` sets a favourite and
`DELETE /api/favorites/{targetType}/{targetId}` clears it.

```ts
type FavoriteRecord = {
  targetType: 'agent' | 'channel' | 'user';
  targetId: string;
  createdAt: string;
};
```

Rules:

- favourites are scoped to the current user and organization
- a target must be visible to the actor before it can be added
- removing a favourite is idempotent so stale client state can be cleared safely

## 6) Agent activity response contracts

### `GET /api/agents/{agentId}/status`

Returns `ApiResponse<AgentStatusResponse>`.

```ts
type AgentStatusResponse = {
  agentId: string;
  status: AgentStatus;
  since: string;
  currentRunId?: string;
  currentToolName?: string;
  currentToolStartedAt?: string;
  activeSubAgents: Array<{ agentId: string; status: AgentStatus; taskId: string }>;
  lastActivityAt: string;
};
```

### `GET /api/agents/{agentId}/activity`

Returns `ApiResponse<AgentActivityResponse>`. This is a richer view than `/status` — it includes the recent tool execution log for the current or most recent run.

```ts
type ToolCallEntry = {
  toolName: string;
  runId: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  success?: boolean;
  inputSummary: string;
  outputPreview?: string;
};

type AgentActivityResponse = {
  agentId: string;
  status: AgentStatus;
  currentRun?: {
    runId: string;
    status: RunStatus;
    startedAt: string;
    toolCalls: ToolCallEntry[];
  };
  recentToolCalls: ToolCallEntry[];
  subAgents: Array<{ agentId: string; name: string; status: AgentStatus; taskId: string; purpose?: string }>;
};
```

Rules:

- `recentToolCalls` returns up to 20 most recent tool calls across all runs, newest first
- `currentRun.toolCalls` returns tool calls for the active run only
- `outputPreview` is truncated to 200 chars and must never contain secrets
- `subAgents` includes all children regardless of parent status (active children of idle parents are visible)

### `GET /api/agents/{agentId}/messages?limit=5`

Returns `ApiResponse<AgentMessage[]>` with pagination.

```ts
type AgentMessage = {
  messageId: string;
  role: 'user' | 'assistant' | 'system';
  contentPreview: string;
  fullContent: string;
  threadId: string;
  timestamp: string;
};
```

Rules:

- default limit is 5, max is 50
- ordered newest-first
- `contentPreview` is truncated to 500 chars
- `fullContent` is the complete message

### `GET /api/agents/{agentId}/children`

Returns `ApiResponse<AgentChild[]>`.

```ts
type AgentChild = {
  agentId: string;
  name: string;
  status: AgentStatus;
  taskId: string;
  purpose?: string;
  parentAgentId: string;
  spawnedAt: string;
};
```

Rules:

- returns currently-active and recently-completed children (last 1 hour or last 10, whichever is more)
- used for initial sub-agent tree population and WebSocket reconnect recovery

## 7) Zod as source of truth

Zod schemas must live next to the shared types in `packages/schemas`.

Rules:

- backend request validation uses the shared Zod schema
- frontend runtime validation uses the same schema
- do not maintain parallel handwritten TS-only and validation-only definitions

## 8) Branded entity IDs

Entity IDs should be branded strings.

Examples:

- `OrganizationId`
- `ProjectId`
- `TeamId`
- `ChannelId`
- `AgentId`
- `ThreadId`
- `RunId`
- `TaskId`

Reason:

- prevents accidentally passing a channel ID where an agent ID is required
- cheap to add
- catches a broad class of mistakes early

## 9) Canonical actor and action context

Do not keep separate `ControlActionEnvelope`, `AccessContext`, and `SecretAccessContext` families that need mapping glue.

Use one hierarchy.

```ts
type VerificationFactorType =
  | 'email_otp'
  | 'email_link'
  | 'totp'
  | 'recovery_code'
  | 'webauthn';

type AccessActor = {
  actorType: 'user' | 'agent' | 'service';
  actorId: string;
  roles?: string[];
};

type TenantContext = {
  organizationId: string;
  projectId?: string;
  teamId?: string;
  channelId?: string;
};

type ActionContext = {
  teamId?: string;
  channelId?: string;
  agentId?: string;
  toolId?: string;
  taskId?: string;
  sessionId?: string;
  threadId?: string;
  requestId: string;
  correlationId?: string;
  purpose?: string;
};

type AccessContext = {
  actor: AccessActor;
  tenant: TenantContext;
  actionContext: ActionContext;
};

type AuthorizedActionContext = AccessContext & {
  approval?: {
    approverId?: string;
    approvalId?: string;
    approvalProof?: string;
    approvalContext?: Record<string, string>;
  };
  verification?: {
    challengeId: string;
    proof: string;
    factorType?: VerificationFactorType;
  };
};
```

Rules:

- every authenticated request starts from `AccessContext`
- actions needing approval/verification use `AuthorizedActionContext`
- resource-specific contracts may extend this, but must not rename the base fields
- `ControlActionEnvelope.context` must use `AuthorizedActionContext`
- do not introduce a separate mapping layer between near-identical context types

## 10) Phase 1 `packages/schemas` contents

Phase 1 must create `packages/schemas` before feature code fans out. This is the exhaustive list of what goes in it for Phase 1:

From this document:

- `ApiResponse<T>`, `ApiError` (section 2)
- `PaginationParams`, `PaginationMeta` (section 3)
- `SseEventMap`, `WsEventMap`, `AgentStatus`, `RunStatus`, `TaskStatus` (section 4)
- `MeResponse` and sub-types (section 5.1)
- Agent activity response types: `AgentStatusResponse`, `AgentActivityResponse`, `ToolCallEntry`, `AgentMessage`, `AgentChild` (section 6)
- Branded entity IDs: `OrganizationId`, `ProjectId`, `TeamId`, `ChannelId`, `AgentId`, `ThreadId`, `RunId`, `TaskId` (section 8)
- Actor context types: `AccessActor`, `TenantContext`, `ActionContext`, `AccessContext`, `AuthorizedActionContext` (section 9)
- Zod validation schemas for all of the above (section 7)

### Phase 2 additions to `packages/schemas`

Phase 2 adds these types when the corresponding features ship:

- `ApprovalRequestStatus`, `ApprovalRequest` response type, approval event payloads (see [approval-gating-spec.md](./approval-gating-spec.md))
- `AuditLogRecord` response type, audit query params (see [audit-trail-spec.md](./audit-trail-spec.md))
- `TokenLedgerEvent`, `ModelPricingProfile` (see [token-ledger-spec.md](./token-ledger-spec.md))
- `PolicyDecision`, `EffectivePolicy` response type (see [policy-enforcement-spec.md](./policy-enforcement-spec.md))
- `ApprovalId`, `AuditLogId`, `PolicyId`, `PolicyBindingId` branded IDs

Not in `packages/schemas` for Phase 2 (deferred to Phase 3+):

- tool registry types
- secret types
- translation types
- verification types
- knowledge-base types
- workflow types
- remote worker protocol types

If a type is shared between `/api` and `/worker` in Phase 1, it goes in `packages/schemas`. If it only exists in one service, it stays local until Phase 2 extraction.

### Phase 3 additions to `packages/schemas`

Phase 3 adds these types when the corresponding features ship:

Tool registry (see [tool-registry-spec.md](./tool-registry-spec.md)):

- `ToolId`, `ToolBundleId`, `ToolGrantId`, `PromptLayerId` branded IDs
- `ToolSource`, `ToolTransport`, `ToolGrantState`, `ToolGrantSource`, `ToolBundleStatus`, `PromptLayerType`, `PromptMergeMode` enums
- `ToolCapabilitySchema`, `ToolRuntimeConfig`, `ToolGrantRecord`, `EffectiveToolGrant` response types
- `ToolSearchDocument`, `ToolSearchResult` search response types
- `NessieToolBundle` manifest schema
- `PromptLayer`, `PromptProfile`, `ManagedAgentProfile` prompt types

Secret management (see [secret-management-spec.md](./secret-management-spec.md)):

- `SecretId`, `SecretBindingId` branded IDs
- `SecretRecord` (metadata only, never the encrypted value)
- `SecretBinding` access binding type
- `SecretAccessContext` extending `AuthorizedActionContext`

Step-up verification (see [step-up-verification-spec.md](./step-up-verification-spec.md)):

- `VerificationChallengeId`, `VerificationFactorId`, `VerificationPolicyId` branded IDs
- `VerificationFactorRequirement`, `VerificationFactorGroup` factor model types
- `VerificationPolicy`, `VerificationChallenge`, `VerificationEnrollment` types

Language and translation (see [language-and-translation-spec.md](./language-and-translation-spec.md)):

- `LanguagePreferences` type
- `MessageTranslationMeta` type

Knowledge base first-party envelope (Phase B):

- `KnowledgeSpaceRecord` with project anchor, scoping columns, visibility, sensitivity tier, provenance envelope
- `KnowledgePageRecord` with tree position, draft/published/archived status, labels, published head pointer; archived pages are direct-readable but not mutable
- `KnowledgePageVersionRecord` append-only markdown body/bodyRef versions with server-derived `authorType`
- `KnowledgeSearchHit` deterministic title/metadata/label search hit with `sourceRef`, `visibilityReason`, `policyChainTrace`
- `KnowledgeProvider` capability flags in `packages/knowledge`

External knowledge facade (future tier; see [knowledge-base-requirements.md](./knowledge-base-requirements.md)):

- `KnowledgeSourceId`, `KnowledgeDocId` branded IDs
- `KnowledgeSourceRecord` source metadata type
- `KnowledgeSearchHit`, `KnowledgeReadPayload`, `KnowledgeSearchSummary` response types
- `KnowledgeBaseToolInput` action payload type

Not in `packages/schemas` for Phase 3 (deferred to Phase 4+):

- remote worker protocol types
- interactive session types
- SSH tool types
- workflow builder types

## 11) Canonical ownership

This document is canonical for:

- API envelope
- pagination
- auth/session response contract
- realtime event catalog
- branded IDs
- actor/action context
- agent activity response contracts
- Phase 1 `packages/schemas` contents

Other docs may reference these contracts, but should not redefine them independently.

## 12) Cross-links

- [hosted-app-architecture.md](./hosted-app-architecture.md)
- [organization-governance-spec.md](./organization-governance-spec.md)
- [approval-gating-spec.md](./approval-gating-spec.md)
- [audit-trail-spec.md](./audit-trail-spec.md)
- [token-ledger-spec.md](./token-ledger-spec.md)
- [policy-enforcement-spec.md](./policy-enforcement-spec.md)
- [phase2-gcp-deployment-spec.md](./phase2-gcp-deployment-spec.md)
- [tool-registry-spec.md](./tool-registry-spec.md)
- [secret-management-spec.md](./secret-management-spec.md)
- [step-up-verification-spec.md](./step-up-verification-spec.md)
- [language-and-translation-spec.md](./language-and-translation-spec.md)
- [knowledge-base-requirements.md](./knowledge-base-requirements.md)
- [functionality.md](./functionality.md)

# Approval Gating Spec

> Status: target-state design for Phase 2.

## 1) Objective

Provide a lightweight, auditable approval workflow that gates sensitive agent actions before they execute. In Phase 2, approval gating is v1: simple request/resolve with expiry, not a full multi-step workflow engine.

The system must:

- pause agent execution when a gated action is requested,
- notify eligible approvers in real time,
- resume or abort execution based on approval/rejection,
- record the full decision trail for audit,
- integrate with the existing task/run state machine without introducing a parallel workflow model.

Cross-links:

- [organization-governance-spec.md](./organization-governance-spec.md) section 4.5
- [shared-type-contracts-spec.md](./shared-type-contracts-spec.md) section 4 (`approval.needed` event, `AuthorizedActionContext.approval`)
- [hosted-app-architecture.md](./hosted-app-architecture.md) section 5 (control-plane invariants)

## 2) Core rules

- every approval request is scoped to one task or run,
- approval requests carry the action description, requesting agent, and reason,
- approvers are resolved from the policy chain (org owner, project admin, channel admin, or explicit approver role),
- approvals have a configurable TTL (default: 1 hour),
- expired approvals auto-reject with reason `APPROVAL_EXPIRED`,
- one approval request may be resolved exactly once (approve or reject),
- resumption after approval must not duplicate side effects (idempotency via continuation token),
- rejection terminates the gated action and transitions the task/run to failed with reason,
- the `waiting_approval` agent status from Phase 1 is now wired to real approval requests.

## 3) Data model

### Prisma schema additions

```prisma
model ApprovalRequest {
  id              String   @id @default(uuid()) @db.Uuid
  organizationId  String   @db.Uuid
  projectId       String?  @db.Uuid
  teamId          String?  @db.Uuid
  channelId       String?  @db.Uuid
  taskId          String?  @db.Uuid
  runId           String?  @db.Uuid
  agentId         String   @db.Uuid
  requesterId     String   @db.Uuid  // the actor (user or agent) who triggered the gated action
  action          String              // machine-readable action name (e.g. "tool.execute.ssh", "file.write.outside_root")
  reason          String              // human-readable description of why approval is needed
  context         Json     @default("{}") // arbitrary context for the approver (tool args, file path, etc.)
  status          ApprovalStatus @default(pending)
  resolverId      String?  @db.Uuid  // the user who approved or rejected
  resolvedAt      DateTime?
  resolution      String?             // "approved" or "rejected"
  resolutionNote  String?             // approver's optional note
  continuationToken String? @unique   // idempotency key for resuming the gated action
  expiresAt       DateTime
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  organization    Organization @relation(fields: [organizationId], references: [id])
  agent           Agent        @relation(fields: [agentId], references: [id])

  @@index([organizationId, status])
  @@index([agentId, status])
  @@index([taskId])
  @@index([runId])
  @@index([status, expiresAt])
}

enum ApprovalStatus {
  pending
  approved
  rejected
  expired
}
```

### `packages/schemas` additions

```ts
type ApprovalRequestRecord = {
  id: string;
  organizationId: OrganizationId;
  projectId?: ProjectId;
  teamId?: TeamId;
  channelId?: ChannelId;
  taskId?: string;
  runId?: string;
  agentId: AgentId;
  requesterId: string;
  action: string;
  reason: string;
  context: Record<string, unknown>;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  resolverId?: string;
  resolvedAt?: string;
  resolution?: 'approved' | 'rejected';
  resolutionNote?: string;
  expiresAt: string;
  createdAt: string;
};
```

## 4) State machine

```
pending --> approved   (explicit approve by authorized user)
pending --> rejected   (explicit reject by authorized user)
pending --> expired    (TTL reached, background sweep or lazy check)
```

Once resolved (approved/rejected/expired), an approval request is immutable.

## 5) Gated action categories (Phase 2 v1)

Phase 2 gates these action categories:

- `tool.execute.privileged` -- any tool not in the safe-tools list
- `agent.spawn.elevated` -- spawning sub-agents with elevated tool grants
- `data.export` -- exporting data outside the organization boundary
- `admin.member.remove` -- removing users from the organization
- `admin.channel.delete` -- deleting a channel

The gate is determined by checking the action against the policy chain. If any policy layer requires approval for the action, a request is created.

Additional gated categories will be added in Phase 3+ as the tool and policy systems expand.

## 6) API endpoints

All endpoints require authentication. All paths are under `/api/`.

### `POST /api/approvals`

Create an approval request. Called internally by the worker when a gated action is detected.

```ts
// Request
{
  taskId?: string;
  runId?: string;
  agentId: string;
  action: string;
  reason: string;
  context?: Record<string, unknown>;
  ttlSeconds?: number; // default 3600
}

// Response -- ApiResponse<ApprovalRequestRecord>
```

### `GET /api/approvals`

List approval requests. Filtered by scope from actor context.

```ts
// Query params
{
  status?: 'pending' | 'approved' | 'rejected' | 'expired';
  agentId?: string;
  channelId?: string;
  limit?: number;  // default 50
  cursor?: string;
}

// Response -- ApiResponse<ApprovalRequestRecord[]> with PaginationMeta
```

### `GET /api/approvals/:approvalId`

Get a single approval request.

```ts
// Response -- ApiResponse<ApprovalRequestRecord>
```

### `POST /api/approvals/:approvalId/resolve`

Approve or reject a pending request. Only authorized approvers may call this.

```ts
// Request
{
  resolution: 'approved' | 'rejected';
  note?: string;
}

// Response -- ApiResponse<ApprovalRequestRecord>
```

Error cases:

- `APPROVAL_NOT_FOUND` (404) -- approval does not exist
- `APPROVAL_ALREADY_RESOLVED` (409) -- already approved/rejected/expired
- `APPROVAL_EXPIRED` (410) -- TTL reached
- `NOT_AUTHORIZED_APPROVER` (403) -- caller does not have approval rights

### `GET /api/approvals/pending/count`

Return count of pending approvals for the current user's scope. Used by the admin UI for badge counts.

```ts
// Response -- ApiResponse<{ count: number }>
```

## 7) Worker integration

### Pause flow

1. Worker detects a gated action (tool execution, spawn, etc.).
2. Worker transitions the run to `waiting_approval` status.
3. Worker transitions the agent to `waiting_approval` status.
4. Worker calls `POST /api/approvals` internally (or directly inserts via shared service).
5. Worker generates a `continuationToken` and stores it on the approval request.
6. Worker emits `approval.needed` WebSocket event.
7. Worker returns from the current job handler -- the job is considered complete (not failed).

### Resume flow

1. User resolves the approval via `POST /api/approvals/:id/resolve`.
2. API updates the approval record.
3. If approved:
   a. API enqueues a `run.resume` job with the `continuationToken`.
   b. Worker picks up the job, verifies the continuation token, and resumes execution.
   c. Worker transitions agent back to `executing`.
4. If rejected:
   a. API transitions the run to `failed` with reason `APPROVAL_REJECTED`.
   b. API transitions the agent to `idle`.
   c. API emits `run.updated` and `agent.status` WebSocket events.

### Expiry sweep

A periodic check (every 60 seconds, via pgqueue or cron job) transitions `pending` approvals past their `expiresAt` to `expired` and fails associated runs.

## 8) WebSocket events

Uses the existing `approval.needed` event from `WsEventMap`:

```ts
'approval.needed': {
  taskId: string;
  approvalId: string;
  agentId: string;
  action: string;
  reason: string;
};
```

New Phase 2 event:

```ts
'approval.resolved': {
  approvalId: string;
  agentId: string;
  resolution: 'approved' | 'rejected' | 'expired';
  resolverId?: string;
};
```

## 9) Approver resolution

Phase 2 v1 uses simple role-based approver resolution:

1. Organization owners can approve any request in their org.
2. Users with the `admin` role on the project/team can approve requests in their scope.
3. The requesting user/agent cannot approve their own request.

Phase 3+ will add explicit approver assignment, delegation, and escalation.

## 10) Frontend integration

### Admin UI additions

- **Approval inbox** in the settings/admin area showing pending approvals
- **Approval badge count** on the navigation showing pending count
- **Approval detail** with action description, context, approve/reject buttons, and optional note
- **Agent detail drawer** enhancement: show pending approval when agent is in `waiting_approval` state with approve/reject inline

### Domain facade

Add `approvals` facade following the standard pattern:

- `approvals/hooks.ts` with `useApprovals()`, `usePendingApprovalCount()`, `useResolveApproval()`
- Cache invalidation on `approval.needed` and `approval.resolved` WebSocket events

## 11) Audit integration

Every approval creation and resolution emits an audit log entry (see [audit-trail-spec.md](./audit-trail-spec.md)):

- `approval.created` -- with requester, action, reason
- `approval.approved` -- with approver, note
- `approval.rejected` -- with approver, note, reason
- `approval.expired` -- with original requester, action

## 12) Cross-links

- [organization-governance-spec.md](./organization-governance-spec.md)
- [shared-type-contracts-spec.md](./shared-type-contracts-spec.md)
- [hosted-app-architecture.md](./hosted-app-architecture.md)
- [audit-trail-spec.md](./audit-trail-spec.md)
- [implementation-phases.md](./implementation-phases.md)

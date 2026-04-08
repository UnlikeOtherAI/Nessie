# Approval Gating Feature - Phase 2 Implementation Readiness Review

**Date**: 2026-04-08  
**Reviewer**: Claude Code Agent  
**Status**: GAPS IDENTIFIED - Not Ready for Phase 2 Closure

## Executive Summary

The approval-gating spec is well-designed and architecturally sound. However, the implementation is **incomplete** across all layers: database schema, API endpoints, worker integration, frontend, and system orchestration. This review identifies critical gaps and provides a concrete, actionable checklist for completion.

**Blocking findings**: 7 critical, 12 major  
**Estimated effort**: 40-50 dev hours for full Phase 2 v1 implementation

---

## 1) STATE MACHINE CONSISTENCY: GAPS IDENTIFIED

### 1.1 Prisma Schema Status

**Finding**: `ApprovalRequest` model does NOT exist in `/api/prisma/schema.prisma`.

- Only `AgentStatus` enum includes `waiting_approval` (correct)
- Only `TaskStatus` enum includes `awaiting_approval` (correct)
- **Missing**: Entire `ApprovalRequest` model from spec section 3

**Current state**:
```prisma
// MISSING ENTIRELY:
enum ApprovalStatus {
  pending
  approved
  rejected
  expired
}

model ApprovalRequest {
  id              String
  organizationId  String
  projectId       String?
  // ... etc
}
```

**Impact**: Cannot execute any approval gating logic; database has no persistence layer.

**Remediation**: Add complete `ApprovalRequest` model + `ApprovalStatus` enum to schema. Include all fields from spec section 3:
- Primary fields: `id`, `organizationId`, `projectId`, `teamId`, `channelId`, `taskId`, `runId`
- Request fields: `agentId`, `requesterId`, `action`, `reason`, `context`
- Resolution fields: `status`, `resolverId`, `resolvedAt`, `resolution`, `resolutionNote`
- Expiry/idempotency: `expiresAt`, `continuationToken`
- Timestamps: `createdAt`, `updatedAt`
- Indexes: `(organizationId, status)`, `(agentId, status)`, `(taskId)`, `(runId)`, `(status, expiresAt)`

### 1.2 Type Contracts in `packages/schemas`

**Finding**: `ApprovalRequestRecord` and `ApprovalStatus` types NOT in `/packages/schemas/src/index.ts`.

The spec (section 3) defines:
```ts
type ApprovalRequestRecord = {
  id: string;
  organizationId: OrganizationId;
  // ... 16 fields
};
```

**Current**: Not present in schemas.

**Impact**: Frontend cannot type-check approval data; API cannot validate requests/responses.

**Remediation**: Add to `packages/schemas/src/index.ts`:
- `ApprovalStatusSchema` enum + type
- `ApprovalRequestRecordSchema` object + type
- `ApprovalRequestCreateSchema` (POST body)
- `ApprovalRequestResolveSchema` (POST /:id/resolve body)
- Export branded `ApprovalId` type

### 1.3 AgentStatus vs Run/Task Status Integration

**Finding**: Spec says worker should transition BOTH agent and run/task to `waiting_approval`. Current code only has display support.

From approval-gating-spec section 7 (Pause flow):
- Step 2: "Worker transitions the run to `waiting_approval` status"
- Step 3: "Worker transitions the agent to `waiting_approval` status"

**Current in `/worker/src/run/execute.ts`**: No pause logic; no `waiting_approval` transition.
**Current in `/api/prisma/schema.prisma`**: `RunStatus` enum does NOT include `waiting_approval`.

Only these exist:
```prisma
enum RunStatus {
  pending
  running
  completed
  failed
  cancelled
}
```

**Remediation**:
- Add `waiting_approval` to `RunStatus` enum (NOT `TaskStatus`; that uses `awaiting_approval`)
- In worker's `executeRunJob`, when gated action is detected, transition run to `waiting_approval`
- Emit `run.updated` WebSocket event

### 1.4 Semantic Clarity Issue

The spec uses inconsistent terms:
- Agent uses `waiting_approval` (in AgentStatus enum)
- Task/Run uses `awaiting_approval` / `waiting_approval` (mixed)

**Spec says** (section 4 state machine):
```
pending --> approved
pending --> rejected
pending --> expired
```

But which entity transitions? **Answer**: The run transitions. The agent status is DERIVED from the run.

**Recommendation**: Clarify in implementation that:
- `RunStatus.waiting_approval` = run is paused pending approval
- `AgentStatus.waiting_approval` = agent's active run is paused pending approval (derived)
- `TaskStatus.awaiting_approval` = legacy Phase 1 status (not used in Phase 2 approval flow)

---

## 2) WORKER PAUSE/RESUME: INCOMPLETE SPECIFICATION

### 2.1 Pause Logic: Unspecified

**Spec says** (section 7.1):
```
1. Worker detects a gated action
2. Transitions run to `waiting_approval`
3. Transitions agent to `waiting_approval`
4. Calls POST /api/approvals internally
5. Generates continuationToken and stores on approval
6. Emits approval.needed WebSocket event
7. Returns from job handler -- job is considered complete (not failed)
```

**Missing from spec**: HOW is the gated action detected?

**Requirement**: Must define:
1. **Gating policy hook**: Where in the worker does it check `action` against policy?
   - Before tool execution?
   - During agent invocation?
   - In a pre-execution policy layer?

2. **Which actions are gated in Phase 2 v1** (spec section 5):
   - `tool.execute.privileged` — any tool not in safe-tools list
   - `agent.spawn.elevated` — spawning sub-agents with elevated grants
   - `data.export` — exporting data outside org
   - `admin.member.remove` — removing users
   - `admin.channel.delete` — deleting channel

**Missing implementation details**:
- How does worker know which tools are "safe"? (needs policy lookup)
- How are elevated grants detected? (needs AgentSpawn context inspection)
- Who runs policy checks: worker or API prehandler?

### 2.2 Job Completion Status Ambiguity

**Spec says**: "job is considered complete (not failed)"

But the worker's `/worker/src/index.ts` shows:
```ts
queueProvider.subscribe('run.execute', async (job) => {
  const payload = RunExecuteJobPayloadSchema.parse(job.payload)
  await executeRunJob(...)
})
```

**Question**: How does the queue provider know the job completed successfully vs. hit an approval gate?

**Current**: No error handling; no way to pause and resume.

**Requirement**: The job handler must:
1. Detect gated action
2. Emit approval request
3. Transition run/agent to `waiting_approval`
4. **NOT throw**; return normally (job succeeds)
5. Queue provider marks job `completed`

Then later, when approval is resolved:
1. API enqueues `run.resume` job (spec section 7.2c)
2. Worker picks up resume job
3. Resume job includes `continuationToken` for idempotency
4. Worker resumes execution from where it left off

**Missing**: `run.resume` job type and resumption logic in worker.

### 2.3 Continuation Token Idempotency: Unclear

**Spec says** (section 7.2b):
> "Worker picks up the job, verifies the continuation token, and resumes execution."

**Question**: What does "verify" mean?

**Requirement**: Define the exact mechanism:
1. When approval request is created, generate a unique `continuationToken`
2. Store on `ApprovalRequest.continuationToken`
3. On resume, API enqueues job with `continuationToken` in payload
4. Worker uses token to fetch approval record and verify:
   - Approval status is `approved` (not `rejected` or `expired`)
   - Token matches the stored token (prevents replay attacks)
5. On match, execute the gated action
6. On mismatch, fail the run with reason `APPROVAL_INVALID_TOKEN` or `APPROVAL_REJECTED`

**Implementation gap**: No token validation logic exists in worker.

---

## 3) WEBSOCKET INTEGRATION: PARTIAL

### 3.1 Current State

`WsEventMap` in `/packages/schemas/src/index.ts` INCLUDES:
```ts
'approval.needed': {
  taskId: TaskId
  approvalId: string
  agentId: AgentId
  action: string
  reason: string
}
```

This is validated and schema-correct.

**Missing event** from spec section 8:
```ts
'approval.resolved': {
  approvalId: string
  agentId: AgentId
  resolution: 'approved' | 'rejected' | 'expired'
  resolverId?: string
}
```

### 3.2 Emission Points: Unspecified in Code

**Spec says**:
- Step 6 (pause flow): "Worker emits `approval.needed` WebSocket event"
- Implicit in resume flow: API should emit `approval.resolved` on resolution

**Current in `/api/src/index.ts`**: No WebSocket emission for approvals at all.

The realtime hub exists (`realtimeHub.publishWs()`), but approval code doesn't use it.

### 3.3 Scope of `approval.needed` Event

**Question**: Which subscopes should receive the event?

**Spec implies**: Published to scopes for the run/task:
- `organization`
- `channel` (if available)
- `agent`

**Requirement**: Define exact scope filtering:
1. Users in the organization see all pending approvals for their org
2. Users with approver role for specific project/team/channel see relevant approvals
3. The requesting agent itself does NOT receive its own approval event (optional)

**Missing**: Scope filtering logic in API.

---

## 4) CONTINUATION TOKENS: MECHANISM UNCLEAR

### 4.1 Token Format

**Spec says** (section 3):
```prisma
continuationToken String? @unique
```

**Questions**:
1. **Format**: UUID or secret string?
   - Recommendation: Random 32-byte hex string (256-bit entropy), NOT UUID
   - Reason: Stronger security, prevents casual guessing
2. **When generated**: During approval request creation or approval acceptance?
   - Spec is silent; recommend generating during request creation, stored immediately
3. **When validated**: On resume job pickup
4. **Lifetime**: Same as approval TTL or indefinite?
   - Recommendation: Same as approval TTL (if approval expires, token is invalid)

### 4.2 Idempotency Mechanism

**Spec says** (section 2): "resumption after approval must not duplicate side effects (idempotency via continuation token)"

**Example scenario**:
1. Worker executes action A (tool call)
2. Tool call modifies external system (e.g., creates AWS instance)
3. Worker suspends before confirming success
4. User approves
5. Worker resumes with continuation token
6. Must NOT re-execute action A (would create duplicate instance)

**Current**: No mechanism to track what's already executed.

**Requirement**: Store **execution context** on approval request:
```ts
interface ApprovalRequest {
  continuationToken: string
  executionContext?: {
    lastExecutedStep: number
    checksum?: string
  }
}
```

Or simpler: Store the `runId` + task state atomically, so resumption can diff what's changed.

---

## 5) EXPIRY SWEEP: NOT IMPLEMENTED

### 5.1 Current State

**Spec says** (section 7):
> A periodic check (every 60 seconds, via pgqueue or cron job) transitions `pending` approvals past their `expiresAt` to `expired` and fails associated runs.

**Current**: No sweep job exists.

### 5.2 Implementation Requirements

Need to add:
1. **Recurring job** in pgqueue:
   - Job topic: `approval.expire_sweep`
   - Schedule: Every 60 seconds
   - Payload: `{ scanOlderThanSeconds: 60 }`
2. **Handler logic**:
   ```
   SELECT * FROM ApprovalRequest 
   WHERE status = 'pending' AND expiresAt < NOW()
   FOR UPDATE
   ```
   For each expired request:
   - Update to status `expired`
   - Find associated run
   - Transition run to `failed` with reason `APPROVAL_EXPIRED`
   - Transition agent to `idle`
   - Emit `run.updated` + `approval.resolved` WebSocket events
   - Emit audit log: `approval.expired`

3. **Job registration**:
   - In worker startup (`/worker/src/index.ts`), subscribe to `approval.expire_sweep`
   - Use pgqueue to enqueue the recurring job

4. **Failure handling**:
   - If a run is in `waiting_approval` but the approval request is gone, the run stays stuck
   - **Safeguard**: Sweep should also check for orphaned runs (no matching approval request)

### 5.3 Race Conditions in Sweep

**Risk**: Multiple workers executing sweep simultaneously.

**Mitigation**: Use Postgres row locking (FOR UPDATE SKIP LOCKED) or pgqueue's distributed job model (single consumer per topic).

---

## 6) FRONTEND FLOW: MAJOR GAPS

### 6.1 Current State

**Facade**: Approval facade NOT created in `/admin/src/facades/`.

Currently exists:
- `/admin/src/facades/agents/hooks.ts` — agent hooks
- No `/admin/src/facades/approvals/hooks.ts`

**Components**: No approval-specific UI components.
- No `ApprovalInbox`
- No `ApprovalDetail`
- No approval badge on navigation
- No inline approve/reject in agent detail

### 6.2 User Experience Flow (From Spec Section 10)

**Required**:
1. **Approval Inbox** — Settings/admin area showing pending approvals
   - List of pending approvals scoped to user
   - Action, reason, requesting agent, timestamp
   - Detail drill-down
2. **Approval Badge Count** — Nav badge showing count of pending approvals for current user
3. **Approval Detail**
   - Action description
   - Context (tool args, file path, etc.)
   - Approve/Reject buttons
   - Optional note field
   - Requestor name and timestamp
4. **Agent Detail Enhancement**
   - When agent is in `waiting_approval`, show inline approval widget
   - Show "Awaiting approval for: [action]"
   - Show approve/reject buttons inline (or link to detail)
5. **Toast/Notification** on approval.resolved WebSocket event
   - "Approval [action] has been approved/rejected"
   - Optional: Auto-refresh agent activity

### 6.3 Component Checklist

Missing components:
- [ ] `ApprovalInbox` — Main approval list view
- [ ] `ApprovalDetail` — Single approval detail modal/drawer
- [ ] `ApprovalBadge` — Navigation badge component
- [ ] `ApprovalResolutionForm` — Approve/reject form with note field
- [ ] `AgentApprovalStatus` — Inline widget for agent detail
- [ ] `ApprovalNeededNotification` — Toast notification on `approval.needed`
- [ ] `ApprovalResolvedNotification` — Toast notification on `approval.resolved`

### 6.4 Facade/Hook Requirements

Missing from `/admin/src/facades/approvals/`:

```ts
export const useApprovals = (filters?: {
  status?: 'pending' | 'approved' | 'rejected' | 'expired'
  agentId?: string
  channelId?: string
}) => {
  // Return paginated list of approvals
  // Refetch on approval.needed event
}

export const usePendingApprovalCount = () => {
  // Return count of pending approvals for current user
  // Auto-update on approval.needed / approval.resolved
}

export const useResolveApproval = () => {
  // Mutation: POST /api/approvals/:id/resolve
  // Input: { resolution: 'approved' | 'rejected', note?: string }
  // On success: invalidate useApprovals cache, show toast
}

export const useApprovalDetail = (approvalId?: string) => {
  // Return single approval record
  // Load on demand
}
```

### 6.5 WebSocket Event Handling

In `useAgentRealtime` (currently `/admin/src/facades/agents/hooks.ts` line 318):

Currently handles: `agent.status`, `agent.tool.start/end`, `agent.spawned`, `run.updated`, `message.new`

**Missing**: Handle `approval.needed` and `approval.resolved`:
```ts
if (message.event === 'approval.needed') {
  // Invalidate approvals cache
  void queryClient.invalidateQueries({ queryKey: ['approvals'] })
  // Show notification
  return
}

if (message.event === 'approval.resolved') {
  // Invalidate approvals + agent caches
  void queryClient.invalidateQueries({ queryKey: ['approvals'] })
  void queryClient.invalidateQueries({ queryKey: ['agents', message.data.agentId, 'activity'] })
  // Show notification with resolution
  return
}
```

---

## 7) RACE CONDITIONS: MITIGATION REQUIRED

### 7.1 Double Approval Race

**Scenario**:
```
T1: User A clicks "Approve" → sends approval request
T2: User B clicks "Approve" → sends approval request (before T1 reaches server)
T3: Both requests reach API simultaneously
```

**Spec says** (section 2): "one approval request may be resolved exactly once"

**Current protection**: None (no implementation).

**Mitigation**:
1. **Database-level constraint**: Mark `status` transition as atomic
   ```sql
   UPDATE ApprovalRequest 
   SET status = $1, resolvedAt = NOW(), resolverId = $2
   WHERE id = $3 AND status = 'pending'
   RETURNING *
   ```
   If no rows affected, request already resolved.

2. **API endpoint response**:
   ```ts
   const updated = await prisma.approvalRequest.update({
     where: { id: approvalId },
     data: { status: resolution, resolverId, ... }
   })
   
   if (!updated) {
     sendApiError(reply, 409, 'APPROVAL_ALREADY_RESOLVED', 'Already resolved')
     return
   }
   ```

3. **Frontend debounce**: Disable button immediately after click, prevent double-submit

### 7.2 Approval Expiry During Approval Window

**Scenario**:
```
T1: Approval request created, expiresAt = now + 1 hour
T2: User clicks "Approve" at T1 + 59 min
T3: Approval expires at T1 + 1 hour (before T2 reaches DB)
T4: Sweep marks approval as expired
T5: T2 request arrives, finds status = 'expired', fails
```

**Mitigation**:
1. **Early expiry check in API endpoint**:
   ```ts
   const approval = await prisma.approvalRequest.findUnique(...)
   if (new Date() > approval.expiresAt) {
     // Don't allow approval; mark as expired and fail run
     sendApiError(reply, 410, 'APPROVAL_EXPIRED', 'Request has expired')
     // Transition run to failed
     return
   }
   ```

2. **Atomic expiry + resolution check**:
   ```ts
   const approval = await prisma.approvalRequest.update({
     where: { id, status: 'pending' },
     data: {
       status: resolution,
       resolvedAt: now,
       resolverId: userId
     }
   })
   
   if (!approval) {
     // Either already resolved or expired
     const existing = await prisma.approvalRequest.findUnique(...)
     if (existing.status === 'expired') {
       return error 410
     } else {
       return error 409
     }
   }
   ```

3. **TTL tolerance**: Allow approvals to be accepted up to 5 seconds after TTL (clock skew tolerance)

### 7.3 Worker Resume Race

**Scenario**:
```
T1: User approves approval for run X
T2: API enqueues run.resume job with continuation token
T3: Sweep simultaneously marks a different expired approval
T4: Two workers pick up: one resumes X, one does sweep
T5: If timing is wrong, may resume already-failed run
```

**Mitigation**:
1. **Resume checks state before executing**:
   ```ts
   const approval = await prisma.approvalRequest.findUnique(...)
   if (approval.status !== 'approved') {
     failRun('APPROVAL_INVALID_STATE')
     return
   }
   
   const run = await prisma.run.findUnique(...)
   if (run.status !== 'waiting_approval') {
     // Already completed or failed
     return (idempotent success)
   }
   ```

2. **Continuation token validates state**:
   - Token is only valid if approval status is 'approved'
   - Verification happens before any side effects

---

## 8) API ENDPOINTS: NOT IMPLEMENTED

### 8.1 Required Endpoints (From Spec Section 6)

**All missing from `/api/src/index.ts`**:

1. **POST /api/approvals** — Create approval request
   - Called internally by worker
   - Validates `action` against policy
   - Creates `ApprovalRequest` record
   - Generates continuation token
   - Response: `ApiResponse<ApprovalRequestRecord>`

2. **GET /api/approvals** — List approvals
   - Query filters: `status`, `agentId`, `channelId`, `limit`, `cursor`
   - Pagination with cursor
   - Scoped to actor's organization/project/team/channel
   - Response: `ApiResponse<ApprovalRequestRecord[]>` + `PaginationMeta`

3. **GET /api/approvals/:approvalId** — Get single approval
   - Verify actor has permission to view
   - Response: `ApiResponse<ApprovalRequestRecord>`

4. **POST /api/approvals/:approvalId/resolve** — Approve/reject
   - Input: `{ resolution: 'approved' | 'rejected', note?: string }`
   - Verify actor is authorized approver
   - Atomic update to prevent double-approval
   - On approval: enqueue `run.resume` job
   - On rejection: transition run to failed
   - Response: `ApiResponse<ApprovalRequestRecord>`
   - Errors: `APPROVAL_NOT_FOUND`, `APPROVAL_ALREADY_RESOLVED`, `APPROVAL_EXPIRED`, `NOT_AUTHORIZED_APPROVER`

5. **GET /api/approvals/pending/count** — Get pending count
   - Used by nav badge
   - Return count of pending approvals for current user
   - Response: `ApiResponse<{ count: number }>`

### 8.2 Authorization Logic

**Approver resolution** (spec section 9):
- Organization owners can approve any request
- Project/team/channel admins can approve requests in their scope
- Requesting user cannot approve their own request

**Implementation**:
```ts
const isApprover = (actorContext, approval) => {
  if (actorContext.actor.roles?.includes('owner')) return true
  
  // Check if actor is admin in relevant scope
  if (approval.projectId) {
    const hasProjectAdmin = checkProjectAdmin(...)
    if (hasProjectAdmin) return true
  }
  
  if (approval.teamId) {
    const hasTeamAdmin = checkTeamAdmin(...)
    if (hasTeamAdmin) return true
  }
  
  if (approval.channelId) {
    const hasChannelAdmin = checkChannelAdmin(...)
    if (hasChannelAdmin) return true
  }
  
  return false
}

if (!isApprover(actorContext, approval)) {
  sendApiError(reply, 403, 'NOT_AUTHORIZED_APPROVER', 'Not authorized')
  return
}
```

---

## 9) WORKER INTEGRATION: INCOMPLETE

### 9.1 Gating Policy Layer

**Missing**: Where does worker check if action is gated?

**Spec says** (section 5): Phase 2 v1 gates:
- `tool.execute.privileged` — non-safe-tools
- `agent.spawn.elevated` — elevated sub-agents
- `data.export` — org boundary exports
- `admin.member.remove` — user removal
- `admin.channel.delete` — channel deletion

**Current in `/worker/src/run/execute.ts`**: Only safe tools are available; no gating logic.

**Requirement**: Add policy check layer:
```ts
interface GatePolicy {
  isGated(action: string, context: ExecutionContext): boolean
  getApprovalReason(action: string, context: ExecutionContext): string
}

// In executeRunJob:
const action = determineAction(toolName) // e.g., 'tool.execute.web_search'
if (gatePolicy.isGated(action, context)) {
  // Request approval
  const approval = await requestApproval({
    action,
    reason: gatePolicy.getApprovalReason(action, context),
    context: { toolName, args: inputSummary }
  })
  
  // Transition run/agent to waiting_approval
  await transitionRunToWaitingApproval(runId, approval.id)
  
  // Emit approval.needed
  await publishApprovalNeeded(...)
  
  // Return (job complete, not failed)
  return
}

// Otherwise, execute as normal
```

### 9.2 Job Resume Handler

**Missing entirely**: `run.resume` job handler.

**Requirement**:
```ts
queueProvider.subscribe('run.resume', async (job) => {
  const payload = RunResumeJobPayloadSchema.parse(job.payload)
  // payload = { runId, continuationToken, actorContext }
  
  const approval = await findApprovalByToken(payload.continuationToken)
  if (!approval || approval.status !== 'approved') {
    await failRun(payload.runId, 'APPROVAL_INVALID_STATE')
    return
  }
  
  // Resume execution
  const runContext = await loadRunContext(payload.runId)
  await resumeExecution(deps, runContext, payload.actorContext)
})
```

### 9.3 Agent Status Management

**Missing**: Transition agent status to `waiting_approval` when run pauses.

**Requirement** (spec section 7.1 step 3):
```ts
// In pause flow:
await prisma.agent.update({
  where: { id: agentId },
  data: { status: 'waiting_approval' }
})

// Emit agent.status event
await publishAgentStatus(realtimeTransport, agentId, 'waiting_approval')

// In resume flow (approval accepted):
await prisma.agent.update({
  where: { id: agentId },
  data: { status: 'executing' }
})

// If rejection:
await prisma.agent.update({
  where: { id: agentId },
  data: { status: 'idle' }
})
```

---

## 10) AUDIT INTEGRATION: MISSING

**Spec section 11**: Every approval creation and resolution emits audit log entry.

**Current**: No audit logging implementation in codebase.

**Requirement**: Add audit events:
- `approval.created` — on POST /api/approvals
- `approval.approved` — on POST /api/approvals/:id/resolve (approved)
- `approval.rejected` — on POST /api/approvals/:id/resolve (rejected)
- `approval.expired` — on approval.expire_sweep

**Note**: This is deferred to Phase 2+ audit trail implementation; flag for later.

---

## IMPLEMENTATION CHECKLIST

### Tier 1: Foundation (Database + Types) — 6-8 hours

- [ ] **Prisma schema**: Add `ApprovalRequest` model + `ApprovalStatus` enum
  - [ ] Run migration: `npx prisma migrate dev --name add_approval_gating`
  - [ ] Regenerate Prisma client
  - [ ] Verify schema compiles

- [ ] **Type contracts**: Add to `packages/schemas/src/index.ts`
  - [ ] `ApprovalStatus` enum + Zod schema
  - [ ] `ApprovalRequestRecord` type + Zod schema
  - [ ] `ApprovalRequestCreate` type + Zod schema
  - [ ] `ApprovalRequestResolve` type + Zod schema
  - [ ] `ApprovalId` branded ID type
  - [ ] `ApprovalResolvedEvent` type + Zod schema
  - [ ] Export from index

- [ ] **RunStatus enum**: Add `waiting_approval` to `RunStatus`
  - [ ] Update Prisma schema
  - [ ] Update `RunStatusSchema` in packages/schemas
  - [ ] Run migration

- [ ] **Event catalog**: Add `approval.resolved` to `WsEventMap` + Zod schema
  - [ ] Update `packages/schemas` `WsEventMap`
  - [ ] Add `ApprovalResolvedEventSchema`
  - [ ] Add to `WsEventSchema` discriminated union

### Tier 2: API Endpoints — 12-15 hours

- [ ] **POST /api/approvals** — Create approval request
  - [ ] Handler function in service layer
  - [ ] Input validation: `ApprovalRequestCreateSchema`
  - [ ] Database insert with continuation token (uuid v4)
  - [ ] Set expiresAt = now + ttlSeconds (default 3600)
  - [ ] Response validation: `ApprovalRequestRecordSchema`
  - [ ] Error handling: validation errors

- [ ] **GET /api/approvals** — List approvals
  - [ ] Query param schema: status, agentId, channelId, limit (default 50), cursor
  - [ ] Scope filtering: only show approvals in actor's org/project/team
  - [ ] Cursor pagination using (updatedAt, id) stable boundary
  - [ ] Response: array of `ApprovalRequestRecord` + `PaginationMeta`

- [ ] **GET /api/approvals/:approvalId** — Get single
  - [ ] Fetch by ID
  - [ ] Verify actor can view (same org)
  - [ ] Return `ApprovalRequestRecord`
  - [ ] Error: `APPROVAL_NOT_FOUND` (404)

- [ ] **POST /api/approvals/:approvalId/resolve** — Approve/reject
  - [ ] Input validation: `ApprovalRequestResolveSchema`
  - [ ] Fetch approval; verify exists and status='pending'
  - [ ] Check expiry: if expiresAt < now, error 410
  - [ ] Verify actor is authorized approver (isApprover logic)
  - [ ] Atomic update: `WHERE id = ? AND status = 'pending'` UPDATE resolution, resolverId, resolvedAt
  - [ ] On approval: enqueue `run.resume` job with continuationToken
  - [ ] On approval: transition run to 'running'
  - [ ] On rejection: transition run to 'failed' with reason 'APPROVAL_REJECTED'
  - [ ] Emit `approval.resolved` WebSocket event
  - [ ] Return updated `ApprovalRequestRecord`
  - [ ] Errors: `APPROVAL_NOT_FOUND`, `APPROVAL_ALREADY_RESOLVED` (409), `APPROVAL_EXPIRED` (410), `NOT_AUTHORIZED_APPROVER` (403)

- [ ] **GET /api/approvals/pending/count** — Badge count
  - [ ] Count where status='pending' and organizationId=actor.org
  - [ ] Return `{ count: number }`

- [ ] **Authorization function**: `isApprover(actorContext, approval)`
  - [ ] Check org owner role
  - [ ] Check project admin role (if projectId present)
  - [ ] Check team admin role (if teamId present)
  - [ ] Check channel admin role (if channelId present)
  - [ ] Return boolean

### Tier 3: Worker Integration — 10-12 hours

- [ ] **Gating policy layer**: Implement `GatePolicy` interface
  - [ ] Define which actions are gated in Phase 2 v1
  - [ ] Implement `isGated(action, context): boolean`
  - [ ] Implement `getApprovalReason(action, context): string`
  - [ ] Implement `getActionContext(action, context): Record<string, unknown>`

- [ ] **Pause flow in executeRunJob** (`worker/src/run/execute.ts`)
  - [ ] After loading run context, check if action is gated
  - [ ] If gated: call `requestApprovalAction`
  - [ ] Transition run to 'waiting_approval'
  - [ ] Transition agent to 'waiting_approval'
  - [ ] Emit `approval.needed` WebSocket event
  - [ ] Emit `run.updated` WebSocket event
  - [ ] Generate and store continuationToken
  - [ ] Return from job handler (don't throw)

- [ ] **Resume flow**: Implement `run.resume` job handler
  - [ ] Subscribe to `'run.resume'` topic
  - [ ] Parse `RunResumeJobPayload` (runId, continuationToken, actorContext)
  - [ ] Fetch approval by continuationToken
  - [ ] Verify status='approved' and not expired
  - [ ] Load run context
  - [ ] Resume execution from suspension point
  - [ ] Transition agent back to 'executing'

- [ ] **Helper functions**:
  - [ ] `async requestApprovalAction(...)` — POST to /api/approvals, return ApprovalRequest
  - [ ] `async transitionRunToWaitingApproval(runId, approvalId)`
  - [ ] `async transitionRunToFailed(runId, reason)`
  - [ ] `async publishApprovalNeeded(...)` via realtimeTransport
  - [ ] `async publishApprovalResolved(...)` via realtimeTransport

- [ ] **Continuation token validation**:
  - [ ] Store token on ApprovalRequest during creation
  - [ ] On resume, fetch approval by token (not by ID)
  - [ ] Verify token hasn't changed
  - [ ] Verify approval status is 'approved'

### Tier 4: Expiry Sweep — 4-6 hours

- [ ] **Sweep job handler** in worker
  - [ ] Subscribe to `'approval.expire_sweep'`
  - [ ] Query: `WHERE status='pending' AND expiresAt < NOW() LIMIT 100`
  - [ ] For each expired approval:
    - [ ] Update to status='expired'
    - [ ] Fetch associated run
    - [ ] Transition run to 'failed' with reason 'APPROVAL_EXPIRED'
    - [ ] Transition agent to 'idle'
    - [ ] Emit `approval.resolved` WebSocket event
    - [ ] Emit `run.updated` WebSocket event
  - [ ] Use FOR UPDATE SKIP LOCKED to prevent double-processing

- [ ] **Recurring enqueue** in worker startup
  - [ ] In `startWorker()`, after queueProvider initialized
  - [ ] Enqueue `approval.expire_sweep` job every 60 seconds
  - [ ] Job should be durable (survive worker restart)

- [ ] **Safety checks**:
  - [ ] Orphaned run detection (run in waiting_approval but no approval request)
  - [ ] Idempotency: idempotency key based on approvalId + 'sweep'

### Tier 5: Frontend — 15-20 hours

- [ ] **Facade** (`admin/src/facades/approvals/`)
  - [ ] Create hooks file: `hooks.ts`
  - [ ] Implement `useApprovals(filters?)` query hook
  - [ ] Implement `usePendingApprovalCount()` query hook
  - [ ] Implement `useResolveApproval()` mutation hook
  - [ ] Implement `useApprovalDetail(approvalId?)` query hook
  - [ ] Cache invalidation on `approval.needed` / `approval.resolved` WebSocket events

- [ ] **Components** (`admin/src/components/features/approvals/`)
  - [ ] `ApprovalInbox` — paginated list of pending approvals
  - [ ] `ApprovalDetail` — drawer showing single approval + approve/reject buttons
  - [ ] `ApprovalResolutionForm` — form with resolution enum + optional note
  - [ ] `ApprovalBadge` — nav badge showing pending count
  - [ ] `ApprovalNeededNotification` — toast on `approval.needed` event
  - [ ] `ApprovalResolvedNotification` — toast on `approval.resolved` event
  - [ ] `AgentApprovalStatus` — inline widget for agent detail when waiting_approval

- [ ] **Integration with AgentDetailDrawer**
  - [ ] When agent status = 'waiting_approval', show `AgentApprovalStatus` component
  - [ ] Show action description, approval detail link, inline approve/reject

- [ ] **WebSocket event handling** in `useAgentRealtime`
  - [ ] Add handler for `'approval.needed'` event
  - [ ] Add handler for `'approval.resolved'` event
  - [ ] Invalidate approval caches on both events
  - [ ] Show notifications on both events

- [ ] **Navigation integration**
  - [ ] Add approval badge to main nav
  - [ ] Add "Approvals" link to admin/settings menu
  - [ ] Link to ApprovalInbox component

### Tier 6: Testing & Safety — 4-6 hours

- [ ] **Unit tests**: API endpoints
  - [ ] Test double-approval race (409 response)
  - [ ] Test expiry check (410 response)
  - [ ] Test authorization (403 response)
  - [ ] Test happy path (approval → run.resume enqueued)
  - [ ] Test rejection (run.failed enqueued)

- [ ] **Integration tests**: Worker pause/resume
  - [ ] Test pause flow: gated action → run waiting_approval → event emitted
  - [ ] Test resume flow: approval accepted → run.resume job → execution resumes
  - [ ] Test continuationToken validation
  - [ ] Test rejection: approval rejected → run failed

- [ ] **E2E scenario test**: Full flow
  - [ ] Agent hits gated action
  - [ ] UI shows approval needed (WebSocket event received)
  - [ ] User approves via API
  - [ ] Agent resumes and completes
  - [ ] UI shows agent idle again

- [ ] **Race condition tests**:
  - [ ] Concurrent approvals on same request
  - [ ] Approval during expiry window
  - [ ] Worker resume after expiry

### Tier 7: Lint & Typecheck — 2-3 hours

- [ ] **ESLint**: Full codebase pass
- [ ] **TypeScript**: Full codebase typecheck, no `any`
- [ ] **Prisma**: Schema validation, migration syntax
- [ ] **Zod**: All schemas compile without warnings

---

## CROSS-CUTTING CONCERNS

### Idempotency & Retries
- Ensure all operations are idempotent (idempotency keys on queue jobs)
- Retries should not duplicate approvals or side effects
- Use database constraints to enforce uniqueness

### Clock Skew & TTL
- Allow 5-second clock skew tolerance on TTL checks
- Use server time (Database NOW()), not client time
- Document assumption that distributed clocks are within 5 seconds

### Error Messages
- All errors must follow API envelope contract (code, message, field?, details?)
- Never expose internal error details in response
- Log detailed errors server-side for debugging

### Monitoring & Observability
- Log all approval operations (create, resolve, expire) with full context
- Emit metrics: approval latency, approval rate, expiry rate
- Alert on: orphaned approvals, sweep failures

---

## SUMMARY TABLE

| Category | Status | Effort | Blocker |
|----------|--------|--------|---------|
| Database schema | NOT STARTED | 2h | YES |
| Type contracts | NOT STARTED | 2h | YES |
| API endpoints | NOT STARTED | 12h | YES |
| Worker pause/resume | NOT STARTED | 10h | YES |
| Expiry sweep | NOT STARTED | 4h | YES |
| Frontend | NOT STARTED | 18h | YES |
| Testing | NOT STARTED | 4h | NO |
| Lint/typecheck | IN PROGRESS | 2h | YES |
| **TOTAL** | | **54h** | |

---

## VERIFIED FINDINGS SUMMARY

### Critical (Blocking Phase 2 Closure)
1. ✓ ApprovalRequest model missing from Prisma schema
2. ✓ ApprovalRequest types missing from packages/schemas
3. ✓ RunStatus.waiting_approval missing from enum
4. ✓ All API endpoints not implemented
5. ✓ Worker pause/resume logic not implemented
6. ✓ Expiry sweep not implemented
7. ✓ Frontend components/facade not created

### Major (Functional Gaps)
1. ✓ Gating policy layer undefined in worker
2. ✓ Continuation token validation mechanism unspecified
3. ✓ Race condition: double approval not prevented
4. ✓ Race condition: expiry during approval window not handled
5. ✓ Approver authorization logic not implemented
6. ✓ WebSocket event approval.resolved not implemented
7. ✓ Audit logging not integrated
8. ✓ Job resume handler not created
9. ✓ Agent status transition (waiting_approval) not integrated
10. ✓ Error handling for approval-related failures incomplete
11. ✓ Scope filtering for approval visibility not specified
12. ✓ Frontend cache invalidation strategy incomplete

---

## RECOMMENDATIONS

1. **Execute Tiers 1-2 first** (foundation + API): 18-23 hours
   - Enables parallel work on worker (Tier 3) and frontend (Tier 5)

2. **Use feature flags** to gate approval logic behind a capability flag
   - Allows merging incomplete work without breaking production
   - Recommend: `capabilities.APPROVAL_GATING_V1`

3. **Implement comprehensive test suite** (Tier 6)
   - Race conditions are subtle; strong test coverage essential
   - Use property-based testing for concurrency scenarios

4. **Add detailed logging** for all approval state transitions
   - Critical for debugging race conditions and TTL issues

5. **Document TTL behavior clearly**
   - Especially: timezone handling, clock skew tolerance, sweep frequency trade-offs

6. **Plan Phase 3 enhancements**
   - Escalation (auto-escalate if not resolved in X minutes)
   - Delegation (approver can delegate to another user)
   - Template approvals (pre-approve certain actions)

---

## CONCLUSION

The approval gating specification is **architecturally sound** but **not ready for Phase 2 closure** due to **complete absence of implementation** across all layers.

**Estimated effort to reach Phase 2 v1 complete**: 50-60 dev hours (including testing + reviews)

**Recommendation**: Begin with Tier 1 (database + types), then parallelize Tiers 2-3-5 across team members.

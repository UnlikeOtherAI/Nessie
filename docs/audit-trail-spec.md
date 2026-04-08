# Audit Trail Spec

> Status: target-state design for Phase 2.

## 1) Objective

Provide an immutable, queryable audit log of all control-plane actions across the organization. The audit trail is a governance and compliance feature, not a debugging tool.

The system must:

- record every control-plane mutation with actor, resource, action, and outcome,
- scope audit entries to the organization hierarchy (org/project/team/channel),
- provide filtered query access to authorized users,
- preserve entries immutably (no update, no delete except by retention policy),
- emit audit entries synchronously with the action (not as a background afterthought).

Cross-links:

- [organization-governance-spec.md](./organization-governance-spec.md) section 5.3
- [hosted-app-architecture.md](./hosted-app-architecture.md) section 8 (Postgres for audit)
- [shared-type-contracts-spec.md](./shared-type-contracts-spec.md) section 9 (actor context)

## 2) Core rules

- every control-plane mutation emits exactly one audit entry,
- audit entries are append-only -- no updates, no soft deletes,
- audit entries carry the full `AuthorizedActionContext` snapshot at time of action,
- audit entries are organization-scoped and respect project/team/channel hierarchy,
- read access to audit logs requires `admin` or `owner` role at the appropriate scope level,
- audit entries must not contain secrets, credentials, or full request/response bodies,
- sensitive fields in action context must be redacted before persistence (e.g. password fields replaced with `[REDACTED]`),
- audit entries must include a `requestId` for correlation with other system events.

## 3) Data model

### Prisma schema additions

```prisma
model AuditLog {
  id              String   @id @default(uuid()) @db.Uuid
  organizationId  String   @db.Uuid
  projectId       String?  @db.Uuid
  teamId          String?  @db.Uuid
  channelId       String?  @db.Uuid
  actorType       String              // "user" | "agent" | "service" | "system"
  actorId         String              // userId, agentId, or service identifier
  action          String              // machine-readable action (e.g. "user.created", "channel.deleted")
  resourceType    String              // "user" | "channel" | "agent" | "approval" | "tool" | "project" | "team" | "organization"
  resourceId      String?             // ID of the affected resource
  outcome         String              // "success" | "denied" | "error"
  reason          String?             // denial reason code or error message
  metadata        Json     @default("{}") // action-specific context (non-sensitive)
  requestId       String              // correlation with request lifecycle
  ipAddress       String?             // client IP when available
  userAgent       String?             // client user-agent when available
  createdAt       DateTime @default(now())

  organization    Organization @relation(fields: [organizationId], references: [id])

  @@index([organizationId, createdAt])
  @@index([organizationId, action])
  @@index([organizationId, actorId])
  @@index([organizationId, resourceType, resourceId])
  @@index([requestId])
}
```

### `packages/schemas` additions

```ts
type AuditLogRecord = {
  id: string;
  organizationId: OrganizationId;
  projectId?: ProjectId;
  teamId?: TeamId;
  channelId?: ChannelId;
  actorType: 'user' | 'agent' | 'service' | 'system';
  actorId: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  outcome: 'success' | 'denied' | 'error';
  reason?: string;
  metadata: Record<string, unknown>;
  requestId: string;
  ipAddress?: string;
  userAgent?: string;
  createdAt: string;
};

type AuditAction =
  // Auth
  | 'auth.bootstrap'
  | 'auth.login'
  | 'auth.logout'
  | 'auth.login_failed'
  // Users
  | 'user.created'
  | 'user.updated'
  | 'user.deleted'
  | 'user.role_changed'
  // Organizations
  | 'organization.updated'
  // Projects
  | 'project.created'
  | 'project.updated'
  | 'project.deleted'
  | 'project.member_added'
  | 'project.member_removed'
  // Teams
  | 'team.created'
  | 'team.updated'
  | 'team.deleted'
  | 'team.member_added'
  | 'team.member_removed'
  // Channels
  | 'channel.created'
  | 'channel.updated'
  | 'channel.deleted'
  | 'channel.member_added'
  | 'channel.member_removed'
  | 'channel.visibility_changed'
  // Agents
  | 'agent.created'
  | 'agent.updated'
  | 'agent.deleted'
  | 'agent.bound'
  | 'agent.unbound'
  // Tools
  | 'tool.granted'
  | 'tool.revoked'
  // Approvals
  | 'approval.created'
  | 'approval.approved'
  | 'approval.rejected'
  | 'approval.expired'
  // Token ledger
  | 'pricing.created'
  | 'pricing.updated'
  | 'pricing.deleted'
  // Policy
  | 'policy.updated'
  | 'policy.evaluated';
```

## 4) Audit emitter

### Service-layer integration

Create a shared audit emitter that all API services call after mutations:

```ts
interface AuditEmitter {
  emit(entry: {
    actorContext: AuthorizedActionContext;
    action: AuditAction;
    resourceType: string;
    resourceId?: string;
    outcome: 'success' | 'denied' | 'error';
    reason?: string;
    metadata?: Record<string, unknown>;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<void>;
}
```

Rules:

- the emitter extracts `organizationId`, `projectId`, `teamId`, `channelId` from `actorContext.tenant`,
- the emitter extracts `actorType`, `actorId` from `actorContext.actor`,
- the emitter extracts `requestId` from `actorContext.actionContext`,
- the emitter writes directly to Postgres in the same transaction when possible, or immediately after the mutation,
- the emitter must never throw in a way that rolls back the primary mutation -- audit write failures should be logged as errors but not block the user action,
- the emitter redacts known sensitive field names from metadata (`password`, `secret`, `token`, `apiKey`, `credential`).

### Fastify hook integration

A Fastify `onResponse` hook can capture `ipAddress` and `userAgent` for all requests. The audit emitter receives these from the request context.

## 5) API endpoints

All endpoints require authentication with `admin` or `owner` role.

### `GET /api/audit-log`

Query audit entries for the caller's organization.

```ts
// Query params
{
  action?: string;           // filter by action type
  actorId?: string;          // filter by actor
  resourceType?: string;     // filter by resource type
  resourceId?: string;       // filter by specific resource
  projectId?: string;        // narrow to project
  teamId?: string;           // narrow to team
  channelId?: string;        // narrow to channel
  outcome?: 'success' | 'denied' | 'error';
  from?: string;             // ISO timestamp lower bound
  to?: string;               // ISO timestamp upper bound
  limit?: number;            // default 50, max 200
  cursor?: string;           // opaque cursor
}

// Response -- ApiResponse<AuditLogRecord[]> with PaginationMeta
```

### `GET /api/audit-log/:entryId`

Get a single audit entry.

```ts
// Response -- ApiResponse<AuditLogRecord>
```

### `GET /api/audit-log/summary`

Aggregate summary for dashboard use.

```ts
// Query params
{
  from?: string;
  to?: string;
  groupBy: 'action' | 'actorId' | 'resourceType' | 'outcome';
}

// Response -- ApiResponse<Array<{ key: string; count: number }>>
```

## 6) Phase 2 audited actions

Every control-plane mutation in Phase 2 must emit an audit entry. The complete list:

| Service | Action | Resource Type |
|---------|--------|---------------|
| Auth | `auth.bootstrap` | user |
| Auth | `auth.login` | user |
| Auth | `auth.logout` | user |
| Auth | `auth.login_failed` | user |
| Users | `user.created` | user |
| Channels | `channel.created` | channel |
| Channels | `channel.member_added` | channel |
| Agents | `agent.created` | agent |
| Agents | `agent.bound` | agent |
| Approvals | `approval.created` | approval |
| Approvals | `approval.approved` | approval |
| Approvals | `approval.rejected` | approval |
| Approvals | `approval.expired` | approval |
| Pricing | `pricing.created` | pricing |
| Pricing | `pricing.updated` | pricing |
| Pricing | `pricing.deleted` | pricing |

Phase 3+ will add: project/team CRUD, tool grants, policy changes, secret access, and member role changes.

## 7) Retention

Phase 2 retention rules:

- audit entries are retained indefinitely by default,
- no automatic purge or archive in Phase 2,
- Phase 5 will add configurable retention policies with export-before-delete support.

## 8) Frontend integration

### Admin UI additions

- **Audit log page** accessible from settings/admin navigation
- **Filterable table** with columns: timestamp, actor, action, resource, outcome
- **Filter controls**: action type dropdown, actor search, date range picker, outcome filter
- **Entry detail** expandable row showing full metadata and request context
- **Summary widget** on the settings dashboard showing recent activity counts

### Domain facade

Add `audit` facade:

- `audit/hooks.ts` with `useAuditLog()`, `useAuditEntry()`, `useAuditSummary()`
- Standard cursor pagination support

## 9) Security

- audit log read access requires `admin` or `owner` role,
- audit log has no write API (entries are created internally only),
- `POST /api/audit-log` does not exist -- this is deliberate,
- metadata must never contain secrets, passwords, tokens, or API keys,
- IP addresses are stored for forensic purposes and are subject to privacy/retention policy in Phase 5.

## 10) Cross-links

- [organization-governance-spec.md](./organization-governance-spec.md)
- [shared-type-contracts-spec.md](./shared-type-contracts-spec.md)
- [hosted-app-architecture.md](./hosted-app-architecture.md)
- [approval-gating-spec.md](./approval-gating-spec.md)
- [implementation-phases.md](./implementation-phases.md)

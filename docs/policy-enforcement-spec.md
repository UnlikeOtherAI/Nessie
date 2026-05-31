# Policy Enforcement Engine

> Status: target-state design.

## 1) Objective

Define the runtime policy enforcement engine that evaluates the merged policy chain from [organization-governance-spec.md](./organization-governance-spec.md) at every access point: routing, tool execution, API endpoints, and approval resolution.

The governance spec defines *what* the policy chain is. This spec defines *how* it is stored, evaluated, cached, and integrated into the running system. Without this spec, the governance model is declarative but not executable.

The engine must:

- store policy rules as first-class Postgres records with explicit scope, resource type, action, and effect,
- evaluate the full chain (organization, project, team, channel, agent, tool, user override) on every access check,
- enforce deny-first semantics with priority-ordered evaluation,
- provide computed effective-policy reads for UI and operator tooling,
- cache results for performance without sacrificing correctness,
- integrate with channel privacy, agent binding, tool visibility, approval gating, and audit trails.

All access checks consume the canonical `AccessContext` from [shared-type-contracts-spec.md](./shared-type-contracts-spec.md). No parallel context types.

## 2) Policy record data model

### 2.1 Prisma enums

```prisma
enum PolicyScope {
  organization
  project
  team
  channel
  agent
  tool
  user

  @@map("policy_scope")
}

enum PolicyResourceType {
  // Phase 2
  agent
  channel
  project
  tool
  session
  task
  review
  approval
  admin
  secret
  // Phase 3
  tool_bundle
  tool_grant
  prompt
  knowledge_space
  knowledge_page
  knowledge_source
  knowledge_document
  verification_factor
  verification_policy
  translation

  @@map("policy_resource_type")
}

enum PolicyAction {
  // Phase 2
  view
  invoke
  create
  edit
  assign
  approve
  review
  search
  export
  admin
  // Phase 3 — secret actions
  resolve        // secret.resolve: decrypt and return plaintext
  rotate         // secret.rotate: replace ciphertext
  revoke         // secret.revoke: invalidate a secret
  bind           // secret.bind / kb.share: create access binding
  // Phase 3 — knowledge-base actions
  link           // kb.link: register a new source
  reindex        // kb.reindex: refresh source index
  summarize      // kb.summarize: compute/refresh summary
  read           // kb.read: fetch full document content
  // Phase 3 — tool registry actions
  import         // tool.bundle.import: import manifest
  grant          // tool.grant: change tool grant state
  // Phase 3 — verification actions
  enroll         // verification.factor.enroll
  challenge      // verification.challenge.start

  @@map("policy_action")
}

enum PolicyEffect {
  allow
  deny

  @@map("policy_effect")
}

enum PolicyActorType {
  user
  agent
  service
  role

  @@map("policy_actor_type")
}
```

### 2.2 PolicyRule model

```prisma
model PolicyRule {
  id             String             @id @default(uuid()) @db.Uuid
  organizationId String             @map("organization_id") @db.Uuid
  scope          PolicyScope
  scopeId        String             @map("scope_id") @db.Uuid
  resourceType   PolicyResourceType @map("resource_type")
  action         PolicyAction
  effect         PolicyEffect
  priority       Int                @default(0)
  conditions     Json?
  createdBy      String             @map("created_by") @db.Uuid
  createdAt      DateTime           @default(now()) @map("created_at")
  updatedAt      DateTime           @updatedAt @map("updated_at")
  bindings       PolicyBinding[]

  @@index([organizationId, scope, scopeId])
  @@index([organizationId, resourceType, action])
  @@map("policy_rules")
}
```

Fields:

- `id` — UUID primary key.
- `organizationId` — the owning organization. Every policy rule belongs to exactly one org.
- `scope` — which level of the chain this rule is attached to: `organization`, `project`, `team`, `channel`, `agent`, `tool`, or `user`.
- `scopeId` — the ID of the entity this policy is attached to (e.g. the project ID for a project-scoped rule, the channel ID for a channel-scoped rule, the user ID for a user override).
- `resourceType` — what kind of resource the rule governs. Values from governance spec section 3.1: `agent`, `channel`, `project`, `tool`, `session`, `task`, `review`, `approval`, `admin`, `secret`.
- `action` — what action the rule governs. Values from governance spec section 3.1: `view`, `invoke`, `create`, `edit`, `assign`, `approve`, `review`, `search`, `export`, `admin`.
- `effect` — `allow` or `deny`.
- `priority` — integer. Higher number is evaluated later in the chain and can override earlier rules at the same scope level. Default 0.
- `conditions` — optional JSON for additional constraints: time windows, IP ranges, approval requirements. Schema defined in section 2.4.
- `createdBy` — the user ID that created this rule.
- `createdAt`, `updatedAt` — standard timestamps.

### 2.3 PolicyBinding model

Links a PolicyRule to specific actors. A rule without bindings applies to no one. A rule with a wildcard binding applies to all actors of that type.

```prisma
model PolicyBinding {
  id           String          @id @default(uuid()) @db.Uuid
  policyRuleId String          @map("policy_rule_id") @db.Uuid
  actorType    PolicyActorType @map("actor_type")
  actorId      String          @map("actor_id")
  createdAt    DateTime        @default(now()) @map("created_at")
  policyRule   PolicyRule      @relation(fields: [policyRuleId], references: [id], onDelete: Cascade)

  @@index([policyRuleId])
  @@index([actorType, actorId])
  @@map("policy_bindings")
}
```

Fields:

- `id` — UUID primary key.
- `policyRuleId` — foreign key to PolicyRule.
- `actorType` — `user`, `agent`, `service`, or `role`.
- `actorId` — the ID of the specific actor. Use the literal string `*` for wildcard (all actors of that type).
- `createdAt` — creation timestamp.

### 2.4 Conditions schema

The `conditions` JSON field on PolicyRule is optional. When present, it must conform to this shape:

```ts
type PolicyConditions = {
  timeWindow?: {
    startHour: number;   // 0-23 UTC
    endHour: number;     // 0-23 UTC
    daysOfWeek?: number[]; // 0=Sunday, 6=Saturday
  };
  ipRanges?: string[];   // CIDR notation
  requiresApproval?: boolean;
  approvalActionType?: string; // e.g. 'tool.execute', 'agent.bind'
  maxUsagePerHour?: number;
};
```

Rules:

- conditions are AND-joined: all present conditions must pass for the rule to apply.
- if `conditions` is null or `{}`, the rule applies unconditionally.
- `requiresApproval` does not block the access check; it modifies the decision output to include `requiresApproval: true` so the caller knows to gate on approval before proceeding.

## 3) Policy chain evaluation algorithm

### 3.1 Input

- `AccessContext` — the canonical actor + tenant + action context from shared-type-contracts-spec.md.
- `resourceType` — the requested resource type (from `PolicyResourceType`).
- `action` — the requested action (from `PolicyAction`).
- `resourceId` — optional; the specific resource instance ID (for resource-specific bindings).

### 3.2 Steps

1. **Collect applicable rules.** Query all `PolicyRule` records where `organizationId` matches the tenant and the rule's scope chain is relevant to the current context. The chain order is:
   - `scope = 'organization'` where `scopeId = tenant.organizationId`
   - `scope = 'project'` where `scopeId = tenant.projectId` (if projectId is set)
   - `scope = 'team'` where `scopeId = tenant.teamId` (if teamId is set)
   - `scope = 'channel'` where `scopeId = actionContext.channelId` (if channelId is set)
   - `scope = 'agent'` where `scopeId = actionContext.agentId` (if agentId is set)
   - `scope = 'tool'` where `scopeId = actionContext.toolId` (if toolId is set)
   - `scope = 'user'` where `scopeId = actor.actorId`

2. **Filter by resource type and action.** Keep only rules where `resourceType` matches the requested resource type and `action` matches the requested action.

3. **Filter by actor match.** Keep only rules where at least one `PolicyBinding` matches:
   - `actorType` matches the actor's type and `actorId` matches the actor's ID, OR
   - `actorType` matches the actor's type and `actorId` is `*` (wildcard), OR
   - `actorType = 'role'` and `actorId` is in the actor's `roles` array.

4. **Evaluate conditions.** For each remaining rule, evaluate the `conditions` field. Drop rules whose conditions are not satisfied (time window outside range, IP not in allowed ranges, etc.).

5. **Sort by scope order then priority.** Assign a scope weight: organization=0, project=1, team=2, channel=3, agent=4, tool=5, user=6. Sort by (scope weight ascending, priority ascending). This means organization-level rules are evaluated first, user overrides last. Within a scope level, lower priority numbers are evaluated first.

6. **Deny-first evaluation.** Walk the sorted list:
   - If any rule has `effect = 'deny'`, the decision is **deny**. Stop. Record the rule as the source.
   - Track the last seen `effect = 'allow'` rule as a candidate.

7. **Final decision.**
   - If an explicit deny was found: denied.
   - If at least one explicit allow was found and no deny: allowed. If the allow rule has `conditions.requiresApproval = true`, set `requiresApproval` on the decision.
   - If no matching rules were found at all: denied with reason `NO_MATCHING_ALLOW`.

### 3.3 Output

```ts
type PolicyDecision = {
  allowed: boolean;
  policyRuleId?: string;
  policySource: string;
  reasonCode: string;
  requiresApproval?: boolean;
  approvalActionType?: string;
};
```

Reason codes:

- `EXPLICIT_DENY` — a deny rule matched.
- `NO_MATCHING_ALLOW` — no allow rule matched after full chain evaluation.
- `CHANNEL_MEMBERSHIP_REQUIRED` — the channel is protected or private and the actor is not a member.
- `APPROVAL_REQUIRED` — access is allowed but requires approval gating.
- `CONDITIONS_NOT_MET` — a rule matched but its conditions (time window, IP, etc.) were not satisfied.
- `SCOPE_NOT_AVAILABLE` — required scope context (projectId, teamId, channelId) was not provided.

`policySource` is human-readable and follows the pattern `{scope}:{scopeId}/{effect}`, e.g. `channel:abc123/deny` or `organization:def456/allow`.

## 4) Effective policy computation

### 4.1 Endpoint

`GET /api/policy/effective`

### 4.2 Query parameters

| Parameter        | Type   | Required | Description                     |
|-----------------|--------|----------|---------------------------------|
| organizationId  | string | yes      | Organization scope              |
| projectId       | string | no       | Narrow to project               |
| teamId          | string | no       | Narrow to team                  |
| channelId       | string | no       | Narrow to channel               |
| agentId         | string | no       | Narrow to agent                 |
| toolId          | string | no       | Narrow to tool                  |
| actorId         | string | no       | Compute for specific actor      |

### 4.3 Response

`ApiResponse<EffectivePolicy>` using the canonical envelope from shared-type-contracts-spec.md.

```ts
type EffectivePolicy = {
  rules: Array<{
    resourceType: string;
    action: string;
    effect: 'allow' | 'deny';
    source: string;
    policyRuleId: string;
  }>;
  scope: {
    organizationId: string;
    projectId?: string;
    teamId?: string;
    channelId?: string;
  };
};
```

### 4.4 Computation

Effective policy is computed on read, never stored. The algorithm:

1. Collect all rules in the scope chain from organization down to the narrowest provided scope parameter.
2. If `actorId` is provided, filter by actor match (same as section 3.2 step 3).
3. For each unique `(resourceType, action)` pair, run the deny-first evaluation (section 3.2 steps 5-7).
4. Return the winning rule for each pair.

This gives the caller a complete matrix of what is allowed and denied at the given scope.

## 5) Caching strategy

### 5.1 Cache key

```
policy:effective:{hash(organizationId + projectId + teamId + channelId + actorId)}
```

All fields are included in the hash. Missing optional fields use the empty string.

### 5.2 Cache layers

- **Redis** (when available): TTL 60 seconds. Serialized as JSON.
- **In-memory LRU** (always available): 100 entries maximum. TTL 60 seconds.

Redis is checked first. On miss, in-memory is checked. On both miss, the full computation runs and populates both layers.

### 5.3 Cache invalidation

Any write to `PolicyRule` or `PolicyBinding` for a given `organizationId` invalidates all cached effective policies for that organization:

- Redis: delete all keys matching `policy:effective:{orgId}:*`.
- In-memory: evict all entries where the organization matches.

### 5.4 Correctness guarantee

Cache is a performance optimization. The system is correct without it. If cache is unavailable or cleared, every check recomputes from Postgres. No stale-read can produce an allow when the durable state would deny.

## 6) Integration points

Policy checks are mandatory at these access boundaries in Phase 2. Each integration point calls `PolicyEnforcer.check()` before proceeding.

### 6.1 Channel access

- **Before listing channels**: check `resourceType=channel, action=view` for the actor in the current org/project/team scope. Exclude channels where the decision is deny.
- **Before reading messages**: check `resourceType=channel, action=view` for the specific channel.
- **Before posting messages**: check `resourceType=channel, action=create` for the specific channel.

### 6.2 Agent binding

- **Before binding an agent to a channel**: check `resourceType=agent, action=invoke` scoped to the target channel.
- **Before listing agents in a channel**: check `resourceType=agent, action=view` for each agent.

### 6.3 Tool visibility and execution

- **Before listing tools**: check `resourceType=tool, action=view` per tool in scope.
- **Before executing a tool**: check `resourceType=tool, action=invoke` for the specific tool in the current channel/agent context.

### 6.4 Approval resolution

- **Before approving or rejecting**: check `resourceType=approval, action=approve` for the actor.

### 6.5 Admin actions

- **Before any CRUD on organization, project, or team**: check `resourceType=admin, action=edit` or `action=create` or `action=admin` as appropriate.

### 6.6 Phase 3: Secret access

- **Before creating a secret**: check `resourceType=secret, action=create`.
- **Before viewing secret metadata**: check `resourceType=secret, action=view`.
- **Before updating secret metadata**: check `resourceType=secret, action=edit`.
- **Before resolving a secret**: check `resourceType=secret, action=resolve` for the actor in the secret's scope chain.
- **Before rotating a secret**: check `resourceType=secret, action=rotate`.
- **Before revoking a secret**: check `resourceType=secret, action=revoke`.
- **Before deleting a secret**: check `resourceType=secret, action=admin`.
- **Before creating a secret binding**: check `resourceType=secret, action=bind`.

### 6.7 Phase 3: Knowledge base access

Phase B ships the governed first-party authoring envelope:

- **Before listing/reading spaces**: check `resourceType=knowledge_space, action=view`.
- **Before creating a space**: check `resourceType=knowledge_space, action=create`.
- **Before editing/archiving a space**: check `resourceType=knowledge_space, action=edit`.
- **Before listing a page tree**: check `resourceType=knowledge_page, action=view`.
- **Before deterministic page search**: check `resourceType=knowledge_page, action=search`.
- **Before reading a page or version history**: check `resourceType=knowledge_page, action=read`.
- **Before creating a page**: check `resourceType=knowledge_page, action=create`.
- **Before editing, moving, restoring, or archiving a page**: check `resourceType=knowledge_page, action=edit`.
- **Before publishing a page**: check `resourceType=knowledge_page, action=approve`.

External facade sources remain a later tier:

- **Before linking an external knowledge source**: check `resourceType=knowledge_source, action=link`.
- **Before reading an external knowledge document**: check `resourceType=knowledge_document, action=read`.
- **Before reindexing/summarizing an external source**: check `resourceType=knowledge_source, action=reindex|summarize`.

### 6.8 Phase 3: Verification

- **Before listing verification policies**: check `resourceType=verification_policy, action=view`.
- **Before enrolling a verification factor**: check `resourceType=verification_factor, action=enroll`.
- **Before revoking a verification factor**: check `resourceType=verification_factor, action=revoke`.
- **Before starting a challenge**: check `resourceType=verification_factor, action=challenge`.
- **Before creating a verification policy**: check `resourceType=verification_policy, action=create`.
- **Before updating a verification policy**: check `resourceType=verification_policy, action=edit`.
- **Before deleting a verification policy**: check `resourceType=verification_policy, action=admin`.

Note: `challenge.verify`, `challenge.resend`, `challenge.cancel`, `factor.verify`, and `factor.list` are self-authenticated operations — the caller must own the challenge/factor, so access is gated by possession, not by policy rules. Listing factors requires actor-match only (callers see their own factors).

### 6.9 Phase 3: Tool registry and grants

- **Before listing tool bundles**: check `resourceType=tool_bundle, action=view`.
- **Before listing prompt layers**: check `resourceType=prompt, action=view`.
- **Before creating a tool**: check `resourceType=tool, action=create`.
- **Before editing a tool**: check `resourceType=tool, action=edit`.
- **Before deleting a tool**: check `resourceType=tool, action=admin`.
- **Before importing a tool bundle**: check `resourceType=tool_bundle, action=import`.
- **Before approving/rejecting a bundle**: check `resourceType=tool_bundle, action=approve`.
- **Before changing a tool grant**: check `resourceType=tool_grant, action=grant`.
- **Before creating a prompt layer**: check `resourceType=prompt, action=create`.
- **Before editing a prompt layer**: check `resourceType=prompt, action=edit`.
- **Before deleting a prompt layer**: check `resourceType=prompt, action=admin`.

### 6.10 Phase 3: Translation

- **Before reading language preferences**: check `resourceType=translation, action=view`.
- **Before changing organization default language**: check `resourceType=translation, action=admin`.
- **Before changing user preferred language**: check `resourceType=translation, action=edit` (users may edit their own; admin can edit others).
- **Before setting a thread language override**: check `resourceType=translation, action=edit` scoped to the thread's channel.
- **Before setting a session language override**: check `resourceType=translation, action=edit` for the actor's own session only.
- **Before previewing a translation**: check `resourceType=translation, action=view`.

### 6.11 Search and discovery

- **Agent search**: filter results through `resourceType=agent, action=view` per result.
- **Tool search**: filter results through `resourceType=tool, action=view` per result.
- **Channel search**: filter results through channel privacy enforcement (section 8).

## 7) PolicyEnforcer service interface

```ts
interface PolicyEnforcer {
  /**
   * Single access check. Returns a PolicyDecision.
   * This is the primary enforcement primitive.
   */
  check(
    ctx: AccessContext,
    resourceType: string,
    action: string,
    resourceId?: string,
  ): Promise<PolicyDecision>;

  /**
   * Batch access check. Returns one PolicyDecision per input check.
   * Used for list filtering where checking each item individually
   * would cause N+1 query patterns.
   */
  checkBatch(
    ctx: AccessContext,
    checks: Array<{
      resourceType: string;
      action: string;
      resourceId?: string;
    }>,
  ): Promise<PolicyDecision[]>;

  /**
   * Compute the full effective policy for a scope.
   * Used by the GET /api/policy/effective endpoint and by
   * operator tooling for policy inspection.
   */
  getEffective(
    scope: TenantContext,
    actorId?: string,
  ): Promise<EffectivePolicy>;

  /**
   * Invalidate all cached effective policies for an organization.
   * Called after any PolicyRule or PolicyBinding write.
   */
  invalidateCache(organizationId: string): Promise<void>;
}
```

`AccessContext`, `TenantContext` are imported from `packages/schemas`. No local redefinitions.

### 7.1 Batch optimization

`checkBatch` must:

- load all applicable rules once per call (single query),
- evaluate each check against the loaded rule set in memory,
- return decisions in the same order as the input array.

This prevents N+1 queries when filtering lists of agents, tools, or channels.

## 8) Channel privacy enforcement

Channel privacy levels defined in governance spec section 2.2 are enforced as follows:

### 8.1 Public channels

- Any organization member can view the channel and read messages.
- No channel membership check required for `view` action.
- Write access may still be restricted by policy rules.

### 8.2 Protected channels

- The channel appears in channel listings for all org members.
- Only channel members (as recorded in `ChannelMember`) can read messages or post.
- Non-members see the channel metadata (name, description) but get `CHANNEL_MEMBERSHIP_REQUIRED` on read/write attempts.

### 8.3 Private channels

- Only channel members can see the channel at all.
- The channel is excluded from listing responses, search results, and discovery endpoints for non-members.
- Any API call referencing a private channel by a non-member returns 404, not 403. This prevents information leakage about the channel's existence.

### 8.4 Implementation

Channel privacy is a pre-filter before policy chain evaluation:

1. Load the channel's `visibility` from the `Channel` model.
2. If `private` and actor is not in `ChannelMember`: return deny with `CHANNEL_MEMBERSHIP_REQUIRED`. Do not proceed to policy chain.
3. If `protected` and the action is `view` (listing): allow the channel to appear. For read/write actions: check `ChannelMember` first; if not a member, return deny with `CHANNEL_MEMBERSHIP_REQUIRED`.
4. If `public`: proceed to normal policy chain evaluation.

Channel privacy checks are membership checks, not policy rule evaluations. They happen before the policy engine runs.

## 9) Membership-aware discovery

Discovery endpoints must return only resources the actor is authorized to see.

### 9.1 Agent listing

- Query agents bound to channels the actor can access.
- For each agent, run `PolicyEnforcer.checkBatch` with `resourceType=agent, action=view`.
- Exclude agents where the decision is deny.
- Agents bound exclusively to private channels the actor cannot access are invisible.

### 9.2 Tool listing

- Query tools available in the actor's current scope (channel, agent, project).
- For each tool, run `PolicyEnforcer.checkBatch` with `resourceType=tool, action=view`.
- Exclude tools where the decision is deny.

### 9.3 Channel listing

- Load all channels in the org/project/team scope.
- Apply channel privacy pre-filter (section 8.4): exclude private channels where actor is not a member.
- For remaining channels, run `PolicyEnforcer.checkBatch` with `resourceType=channel, action=view`.
- Exclude channels where the decision is deny.

## 10) Approval gating integration

Some policy rules include `conditions: { requiresApproval: true, approvalActionType: '...' }`.

### 10.1 Flow

1. Caller invokes `PolicyEnforcer.check()`.
2. If the decision is `allowed: true, requiresApproval: true`:
   - the caller must create an `ApprovalRequest` (see approval-gating-spec.md) before executing the action,
   - the `approvalActionType` from the decision is used as the approval request's action type,
   - execution is blocked until the approval is resolved.
3. If the caller already has a valid `approval` in their `AuthorizedActionContext`:
   - the `PolicyEnforcer` verifies the approval proof matches the current action,
   - if valid, the decision is `allowed: true, requiresApproval: false`.

### 10.2 Approval-required actions

Approval gating is configured per policy rule, not hardcoded. Common configurations:

- `resourceType=tool, action=invoke` with `approvalActionType='tool.execute'` for destructive tools.
- `resourceType=agent, action=invoke` with `approvalActionType='agent.bind'` for binding agents to sensitive channels.
- `resourceType=admin, action=admin` with `approvalActionType='admin.destructive'` for org-level destructive operations.

## 11) Audit integration

### 11.1 Deny audit

Every policy check that results in a deny emits an audit event with:

- `actor` — from the `AccessContext`.
- `resource` — the requested `resourceType` and `resourceId`.
- `requestedAction` — the requested action.
- `decision` — `deny`.
- `policySource` — from the `PolicyDecision`.
- `reasonCode` — from the `PolicyDecision`.
- `evidence` — relevant context: channel membership IDs, route candidate IDs, scope chain details.

### 11.2 Allow audit (sensitive resources)

Allowed checks are audit-logged only for sensitive resource types:

- `approval` — all allow decisions logged.
- `admin` — all allow decisions logged.
- `secret` — all allow decisions logged.

Other resource types log allows only when the `conditions` field included `requiresApproval`.

### 11.3 Audit format

Audit events follow the format defined in audit-trail-spec.md. The policy enforcement engine emits structured events; it does not own the audit storage layer.

## 12) API endpoints

All endpoints use the `/api/` prefix per hosted-app-architecture.md section 13.

### 12.1 Effective policy

`GET /api/policy/effective`

Described in section 4. Returns `ApiResponse<EffectivePolicy>`.

### 12.2 Inline access check

`POST /api/policy/check`

Request body:

```ts
type PolicyCheckRequest = {
  actorId: string;
  resourceType: string;
  action: string;
  scope: TenantContext;
  resourceId?: string;
};
```

Response: `ApiResponse<PolicyDecision>`.

### 12.3 List policy rules

`GET /api/policy/rules`

Query parameters:

| Parameter        | Type   | Required | Description                     |
|-----------------|--------|----------|---------------------------------|
| organizationId  | string | yes      | Filter by organization          |
| scope           | string | no       | Filter by scope level           |
| scopeId         | string | no       | Filter by specific scope entity |
| resourceType    | string | no       | Filter by resource type         |
| cursor          | string | no       | Pagination cursor               |
| limit           | number | no       | Page size (default 50, max 200) |

Response: `ApiResponse<PolicyRule[]>` with `PaginationMeta`.

### 12.4 Create policy rule

`POST /api/policy/rules`

Request body:

```ts
type CreatePolicyRuleRequest = {
  organizationId: string;
  scope: PolicyScope;
  scopeId: string;
  resourceType: PolicyResourceType;
  action: PolicyAction;
  effect: PolicyEffect;
  priority?: number;
  conditions?: PolicyConditions;
};
```

Response: `ApiResponse<PolicyRule>`. HTTP 201.

Side effect: calls `PolicyEnforcer.invalidateCache(organizationId)`.

### 12.5 Update policy rule

`PUT /api/policy/rules/{ruleId}`

Request body: partial `CreatePolicyRuleRequest` (only fields being changed).

Response: `ApiResponse<PolicyRule>`.

Side effect: calls `PolicyEnforcer.invalidateCache(organizationId)`.

### 12.6 Delete policy rule

`DELETE /api/policy/rules/{ruleId}`

Response: HTTP 204.

Side effect: cascades to delete all `PolicyBinding` records for the rule. Calls `PolicyEnforcer.invalidateCache(organizationId)`.

### 12.7 Add actor binding

`POST /api/policy/rules/{ruleId}/bindings`

Request body:

```ts
type CreatePolicyBindingRequest = {
  actorType: PolicyActorType;
  actorId: string;
};
```

Response: `ApiResponse<PolicyBinding>`. HTTP 201.

Side effect: calls `PolicyEnforcer.invalidateCache(organizationId)`.

### 12.8 Remove actor binding

`DELETE /api/policy/rules/{ruleId}/bindings/{bindingId}`

Response: HTTP 204.

Side effect: calls `PolicyEnforcer.invalidateCache(organizationId)`.

## 13) MCP parity

The following MCP tool names mirror the HTTP endpoints:

| MCP tool name           | HTTP equivalent                              |
|------------------------|----------------------------------------------|
| `policy.check`         | `POST /api/policy/check`                     |
| `policy.effective`     | `GET /api/policy/effective`                   |
| `policy.rules.list`    | `GET /api/policy/rules`                       |
| `policy.rules.create`  | `POST /api/policy/rules`                      |
| `policy.rules.update`  | `PUT /api/policy/rules/{ruleId}`              |
| `policy.rules.delete`  | `DELETE /api/policy/rules/{ruleId}`           |

MCP tools use the same request/response shapes as their HTTP counterparts. They require `actorContext` and follow the same allow/deny reason model.

## 14) Phase 2 default policies

These seed policies are created automatically during organization setup. They provide sensible defaults that admins can override.

### 14.1 Organization-level defaults

- **Allow all members to view public channels.** Scope: organization. Resource: channel. Action: view. Effect: allow. Binding: actorType=role, actorId=member. Priority: 0.
- **Deny non-admin users from admin actions.** Scope: organization. Resource: admin. Action: admin. Effect: deny. Binding: actorType=role, actorId=member. Priority: 0.
- **Allow admin users all admin actions.** Scope: organization. Resource: admin. Action: admin. Effect: allow. Binding: actorType=role, actorId=admin. Priority: 10.

### 14.2 Project-level defaults

Created when a project is created:

- **Allow project members to view agents.** Scope: project. Resource: agent. Action: view. Effect: allow. Binding: actorType=role, actorId=member. Priority: 0.
- **Allow project members to invoke agents.** Scope: project. Resource: agent. Action: invoke. Effect: allow. Binding: actorType=role, actorId=member. Priority: 0.
- **Allow project members to view tools.** Scope: project. Resource: tool. Action: view. Effect: allow. Binding: actorType=role, actorId=member. Priority: 0.

### 14.3 Channel-level defaults

Created when a channel is created, based on visibility:

- **Public channel**: allow rule for `resourceType=channel, action=view` bound to `actorType=role, actorId=member` at priority 0.
- **Protected channel**: allow rule for `resourceType=channel, action=view` bound to `actorType=role, actorId=member` at priority 0. Read/write gated by channel membership check (section 8.2), not policy rules.
- **Private channel**: no default allow rules. Access is exclusively through channel membership (section 8.3).

### 14.4 Seeding mechanism

Default policies are created inside the same database transaction as the entity they belong to (organization, project, or channel). If entity creation fails, no orphaned policy rules remain.

## 15) Cross-links

- [organization-governance-spec.md](./organization-governance-spec.md) — policy chain definition, actions/resources matrix, privacy levels
- [shared-type-contracts-spec.md](./shared-type-contracts-spec.md) — AccessContext, TenantContext, ActionContext, AuthorizedActionContext, PolicyDecision, EffectivePolicy
- [approval-gating-spec.md](./approval-gating-spec.md) — approval request lifecycle, approval proof validation
- [audit-trail-spec.md](./audit-trail-spec.md) — audit event format, storage, and query
- [hosted-app-architecture.md](./hosted-app-architecture.md) — control-plane invariants (section 5), API path prefix rule (section 13)

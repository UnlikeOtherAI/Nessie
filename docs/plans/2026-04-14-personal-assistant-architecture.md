# Personal Assistant Architecture

> Status: proposed implementation brief for per-user personal assistants.

## 1. Architecture Overview

Every real user should get exactly one private personal assistant conversation surface, but not one shared agent. The correct model is:

- one admin-managed personal assistant template
- one private assistant instance per user
- one private DM channel per user-assistant pair

The template is global and editable only by admins. The instance is derived from that template, linked to one user, and isolated from every other user at the data, routing, memory, and realtime layers.

This must not be implemented as "one shared assistant agent bound to many private channels". That creates privacy and state-bleed risk. The assistant needs shared configuration, but separate runtime identity, separate memory, separate DM thread, and separate access control for each user.

## 2. Logical Architecture

### Core objects

- `PersonalAssistantTemplate`
  - org-scoped singleton
  - admin-owned
  - source of truth for prompt, provider, model, tool policy, display name, avatar
- `Agent`
  - used for the actual runtime identity
  - personal assistant instances are normal agents with extra ownership metadata
- `PersonalAssistantInstance`
  - links one `userId` to one `agentId` and one `channelId`
  - carries template version and lifecycle state
- `Channel`
  - private DM surface for that user and that assistant only
- `Thread`
  - normal conversation thread inside that private channel
- `Thought` / memory
  - strictly scoped to the user-owned assistant instance, never to the template

### Responsibility split

- Admin edits the template.
- System lazily creates the instance and DM when the user opens the assistant for the first time.
- Routing always selects that user's assistant instance inside that DM.
- No team, channel, or agent directory flow is allowed to expose another user's assistant instance.

## 3. Physical/Deployment Topology

No new service is required. This should stay inside the existing `/api` + `/admin` + `/packages` structure.

- `/api`
  - template CRUD
  - find-or-create personal assistant instance
  - find-or-create assistant DM
  - membership and visibility enforcement
- `/admin`
  - template editor for owners/admins
  - DM list and assistant-first entry for end users
- `/worker`
  - unchanged runtime execution path; it just receives a different agent identity
- `/packages/schemas`
  - new contracts for template, instance, and assistant-launch responses

## 4. API Backend

### Recommended model

Add a dedicated template record instead of treating one mutable agent as the master copy.

Suggested Prisma models (these extend the existing `schema.prisma`):

```prisma
model PersonalAssistantTemplate {
  id               String   @id @default(uuid())
  organizationId   String
  name             String
  systemPrompt     String
  provider         String?
  model            String?
  routingProfileId String?             // references InferenceRoutingProfile
  toolPolicy       Json     @default("{}")
  active           Boolean  @default(true)
  version          Int      @default(1)  // auto-incremented on each admin save
  createdByActorId String
  updatedByActorId String
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  organization     Organization @relation(fields: [organizationId], references: [id])
  routingProfile   InferenceRoutingProfile? @relation(fields: [routingProfileId], references: [id])
  instances        PersonalAssistantInstance[]

  @@unique([organizationId])            // singleton per org
}

model PersonalAssistantInstance {
  id              String   @id @default(uuid())
  organizationId  String
  userId          String
  agentId         String   @unique      // 1:1 with Agent
  channelId       String   @unique      // 1:1 with Channel
  templateId      String
  templateVersion Int                   // snapshot of template version at creation/last sync
  status          String   @default("active") // active | suspended | archived
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  organization    Organization @relation(fields: [organizationId], references: [id])
  user            User         @relation(fields: [userId], references: [id])
  agent           Agent        @relation(fields: [agentId], references: [id])
  channel         Channel      @relation(fields: [channelId], references: [id])
  template        PersonalAssistantTemplate @relation(fields: [templateId], references: [id])

  @@unique([organizationId, userId])    // one instance per user per org
}
```

Add fields to the existing `Agent` model:

```prisma
model Agent {
  // ... existing fields ...
  agentKind          String  @default("shared")  // "shared" | "personal_assistant"
  ownerUserId        String?                     // required when agentKind = personal_assistant
  managedByTemplateId String?                    // links to PersonalAssistantTemplate.id
  personalAssistantInstance PersonalAssistantInstance?
}
```

### Template versioning strategy

- `version` is an integer, auto-incremented each time an admin saves the template via `PUT /api/admin/personal-assistant-template`.
- Instance `templateVersion` records which template version was last applied.
- Template changes do NOT auto-propagate to existing instances. The `rotate` endpoint (or a background job) compares `instance.templateVersion < template.version` and applies changes.
- Prompt changes propagate to the agent's `systemPrompt`. Provider/model changes propagate to the agent's `provider`/`model`/`routingProfileId`.
- The previous system prompt is NOT versioned in the instance — conversation history preserves the context of what prompt was active at the time.

### Inference routing integration

The template should prefer `routingProfileId` over raw `provider`/`model` fields. This aligns with the existing `InferenceRoutingProfile` system that supports single, fallback, committee, and pipeline routing modes. If `routingProfileId` is set, it takes precedence. Raw `provider`/`model` are a convenience shortcut that the bootstrap endpoint resolves into a single-route profile internally.

### Required endpoints

- `GET /api/personal-assistant`
  - returns the caller's assistant instance + DM channel if it exists
  - returns `null` fields if no instance yet (do NOT auto-create on GET)
- `POST /api/personal-assistant/bootstrap`
  - find-or-create template-derived instance and private DM for current user
  - idempotent: repeated calls return the same instance
  - response shape:
    ```json
    {
      "instance": { "id", "agentId", "channelId", "templateVersion", "status" },
      "agent": { "id", "name", "status" },
      "channel": { "id", "label", "type": "dm", "visibility": "private" },
      "thread": { "id", "label": "General" }
    }
    ```
  - error cases:
    - `PERSONAL_ASSISTANT_NOT_CONFIGURED` (404) — no active template exists
    - `PERSONAL_ASSISTANT_TEMPLATE_INACTIVE` (409) — template exists but `active = false`
    - `PERSONAL_ASSISTANT_ALREADY_EXISTS` (200) — returns existing instance (not an error, just idempotent)
- `GET /api/admin/personal-assistant-template`
  - admin-only; returns template + instance count + last rotation timestamp
- `PUT /api/admin/personal-assistant-template`
  - admin-only; auto-increments `version` on save
- `POST /api/admin/personal-assistant-template/rotate`
  - admin-only; applies template changes to existing instances
  - accepts optional `{ dryRun: boolean }` to preview affected instances
  - applies changes in batches to avoid locking
- `DELETE /api/admin/personal-assistant-template`
  - admin-only; deactivates the template (does NOT delete instances or conversations)
  - sets `template.active = false` and `instance.status = 'suspended'` for all instances

### Backend rules

- Instance creation must be idempotent and race-safe.
- Use a unique constraint on `(organization_id, user_id)`.
- The DM must also be unique and deterministic for that instance.
- The assistant DM must never be creatable through generic "bind agent to channel".
- Personal assistant agents must never be creatable through generic "create agent" UI.

### DM key construction

The existing `findOrCreateDmChannel()` uses `dmKey = org:team:sorted([user1,user2])` for user-to-user DMs. For personal assistant DMs, use a distinct key format to avoid collisions:

```
dmKey = `pa:${organizationId}:${userId}:${agentId}`
```

This ensures:
- deterministic lookup for idempotent bootstrap
- no collision with user-to-user DM keys (different prefix)
- the `dmKey` unique constraint in Prisma handles race conditions on concurrent bootstrap calls

### Bootstrap concurrency

The bootstrap endpoint must use a transaction that:
1. `findFirst` the existing instance by `(organizationId, userId)` — return if found
2. Creates agent, channel, binding, thread, and instance in a single Prisma `$transaction`
3. Relies on the `@@unique([organizationId, userId])` constraint to reject the loser in a race
4. Catches unique constraint violation and retries as a read-only lookup

## 5. Web Application

### User UX

- Show `Personal Assistant` as the first direct-message entry.
- When tapped:
  - call bootstrap endpoint
  - navigate to the returned private DM channel
- Do not show this assistant in team channels, agent add popups, or generic channel binding UI.

### Admin UX

- Add a dedicated admin page or dedicated section in the existing agent designer for:
  - display name
  - master prompt
  - provider/model
  - tool policy
  - template version / rollout state

Admins should edit the template, not individual user instances.

### UI rules

- The current `Personal` category cannot be reused as-is. It is not ownership-based today.
- Personal assistant rows should be visually marked as managed/system-generated.
- There must be no "clone to personal collection" path for this feature.

## 6. Database and Data Access

### Channel shape

Reuse `Channel` and `Thread`, but add assistant-DM metadata instead of inventing a parallel message store.

Recommended additions on `channels`:

- `dm_target_type`: `user` | `assistant`
- `dm_target_user_id`: nullable
- `dm_target_agent_id`: nullable

For a personal assistant DM:

- `type = dm`
- `visibility = private`
- exactly one human member in `channel_members`
- exactly one bound assistant instance in `agent_bindings`
- `dm_target_type = assistant`
- `dm_target_agent_id = assistant instance agent id`

### Data access rules

- Queries for channels, threads, agents, messages, thoughts, and realtime scopes must filter on the same ownership rule.
- For personal assistants, ownership is:
  - `channel_members.user_id = caller`
  - `agent.owner_user_id = caller`
- Admin ownership does not imply transcript visibility.

### Thought/memory scoping

The existing `Thought` model has `ownerId` and `visibility` fields. For personal assistant memory:

- All `Thought` records created by a personal assistant agent must set:
  - `ownerId = agent.id` (the instance's agent, not the template)
  - `visibility = 'private'`
- Memory retrieval (`loadThoughts`, `recallThoughts`) must add a filter: `agentId = instance.agentId` when the caller is a personal assistant.
- The `ThoughtRecall` signal table must also be scoped by agent instance.
- Template rotation must NOT clear or migrate thoughts — they belong to the instance, not the template.
- A future "memory wipe" feature should archive (soft-delete) thoughts rather than hard-delete.

### Run and execution scoping

- `Run` records created for personal assistant agents must set `agentId` to the instance's agent (already the case for normal agent runs).
- `ToolCall` records are scoped via their parent `Run` — no additional scoping needed.
- `Task` records spawned by a personal assistant agent are already scoped by `agentId`.
- The `loadAgentActivity()` function already filters by `agentId`, which is correct.

### Token and cost attribution

- `TokenLedgerEvent` records must be attributed to the personal assistant's `agentId`, not the template.
- The `ExecutionUsageLedger` should track personal assistant usage under a dedicated meter type or tag so admins can see aggregate PA cost without seeing individual transcripts.
- The `/tokens` admin page should show aggregate personal assistant usage (total across all instances) without exposing per-user breakdown in the default view.

## 7. Shared Packages

Add only contracts and validation here.

Allowed in `packages/schemas`:

```typescript
// packages/schemas/src/personal-assistant.ts

export const AgentKindSchema = z.enum(['shared', 'personal_assistant'])
export type AgentKind = z.infer<typeof AgentKindSchema>

export const ChannelDmTargetTypeSchema = z.enum(['user', 'assistant'])
export type ChannelDmTargetType = z.infer<typeof ChannelDmTargetTypeSchema>

export const PersonalAssistantTemplateSchema = z.object({
  id: z.string().uuid(),
  organizationId: OrganizationIdSchema,
  name: z.string().min(1).max(100),
  systemPrompt: z.string(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  routingProfileId: z.string().uuid().nullable(),
  toolPolicy: z.record(z.boolean()),
  active: z.boolean(),
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})

export const PersonalAssistantInstanceSchema = z.object({
  id: z.string().uuid(),
  organizationId: OrganizationIdSchema,
  userId: UserIdSchema,
  agentId: AgentIdSchema,
  channelId: ChannelIdSchema,
  templateId: z.string().uuid(),
  templateVersion: z.number().int().positive(),
  status: z.enum(['active', 'suspended', 'archived']),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})

export const BootstrapPersonalAssistantResponseSchema = z.object({
  instance: PersonalAssistantInstanceSchema,
  agent: AgentRecordSchema,
  channel: ChannelRecordSchema,
  thread: ThreadRecordSchema,
})

export const PersonalAssistantErrorCodeSchema = z.enum([
  'PERSONAL_ASSISTANT_NOT_CONFIGURED',
  'PERSONAL_ASSISTANT_TEMPLATE_INACTIVE',
  'PERSONAL_ASSISTANT_ACCESS_DENIED',
  'PERSONAL_ASSISTANT_BINDING_FORBIDDEN',
  'PERSONAL_ASSISTANT_ALREADY_EXISTS',
])
```

Do not place Prisma models, data access, or privacy rules in shared packages.

## 8. Auth, Validation, Error Handling

### Access rules

- Users can access only their own personal assistant instance.
- Owners/admins can edit the template.
- Owners/admins cannot read personal assistant conversations by default.
- Break-glass support access, if ever added, must be explicit, audited, time-bounded, and off by default.

### Validation rules

- Reject any attempt to bind a `personal_assistant` agent to a team channel.
- Reject any attempt to add a personal assistant to a team or category that exposes it outside the owner.
- Reject generic cloning of personal assistant instances.
- Reject direct instance prompt edits outside the admin template flow unless a future per-user override feature is intentionally added.

### Error model

Use explicit codes:

- `PERSONAL_ASSISTANT_NOT_CONFIGURED`
- `PERSONAL_ASSISTANT_TEMPLATE_INACTIVE`
- `PERSONAL_ASSISTANT_ACCESS_DENIED`
- `PERSONAL_ASSISTANT_BINDING_FORBIDDEN`
- `PERSONAL_ASSISTANT_ALREADY_EXISTS`

## 9. Policy, Trigger, Workflow, and Audit Integration

### Policy system integration

The existing `PolicyRule` / `PolicyBinding` system should be leveraged rather than building ad-hoc access control:

- Seed a default policy rule at template creation time:
  - scope: `agent`, resourceType: `agent`, action: `view`, effect: `deny`, actorType: `*`
  - This denies all actors from viewing the personal assistant agent by default.
- Add a counterpart allow rule scoped to the owner:
  - actorType: `user`, actorId: `instance.userId`, effect: `allow`
- Admin template edit permission uses:
  - resourceType: `admin`, action: `edit`, scoped to `organization`
- Admin transcript access (if ever enabled) must be a separate policy rule with `requiresApproval: true` in conditions.

This approach means `checkPolicy()` naturally handles personal assistant access without special-casing in every service function.

### Trigger restrictions

Personal assistant agents must be excluded from the trigger system:

- `createAgentTrigger()` must reject triggers where `agent.agentKind = 'personal_assistant'`.
- The triggers admin page must not list personal assistant agents as trigger targets.
- Error code: `PERSONAL_ASSISTANT_BINDING_FORBIDDEN` (reuse from section 8).

### Workflow restrictions

Personal assistant agents must not be usable as workflow step executors:

- `createWorkflowTemplate()` must not reference personal assistant agents in `graphJson` steps.
- `installWorkflowTemplate()` binding resolution must reject personal assistant agent IDs.
- The workflow designer agent picker must filter out `agentKind = 'personal_assistant'` agents.

### Mailbox isolation

The `AgentMailboxMessage` system allows inter-agent messaging. Personal assistant agents:

- Must not receive mailbox messages from agents outside their own channel scope.
- Must not be targetable by other agents' `sendMailboxMessage()` calls unless explicitly initiated by the user in their DM thread.
- The orchestrator should not auto-route cross-channel messages to personal assistant agents.

### Audit logging

Personal assistant actions should be audited, but with privacy considerations:

- Log agent lifecycle events: creation, suspension, reactivation, memory wipe.
- Log template changes: version bumps, rotations, deactivation.
- Do NOT log message content in audit logs — the `AuditLog.detail` field must not contain transcript text.
- Log access attempts: any denied access to a personal assistant channel or agent.
- Use `actorType = 'system'` for auto-provisioning events, `actorType = 'user'` for bootstrap.

### Clone and export guards

The existing `cloneAgentRecord()` function in `agents.ts` must check:

```typescript
if (sourceAgent.agentKind === 'personal_assistant') {
  throw new ForbiddenError('PERSONAL_ASSISTANT_BINDING_FORBIDDEN')
}
```

Similarly, any future agent export/import flow must strip or reject personal assistant agents.

## 10. Realtime Events

Personal assistant channels use the existing WebSocket event system but with stricter scoping.

### Event routing rules

- All events for personal assistant channels must be emitted on `{kind: 'channel', channelId}` scope ONLY.
- Events must NOT be emitted on `{kind: 'organization', organizationId}` scope — this prevents other users (including admins) from receiving PA message events.
- Events must NOT be emitted on `{kind: 'agent', agentId}` scope unless the subscriber is the PA owner.

### Relevant event types

These existing events apply to personal assistant channels without modification:

- `message.new` — new message in PA thread
- `message.reaction` — reaction (only the owner can react)
- `agent.status` — PA agent status change (idle/thinking/executing)
- `agent.tool.start` / `agent.tool.end` — tool invocation lifecycle
- `run.updated` — run status change

### New event types to add

- `personal_assistant.bootstrapped` — emitted to the user when their PA instance is created for the first time
- `personal_assistant.template_updated` — emitted to all active PA channels when a rotation applies a template change
- `personal_assistant.suspended` — emitted when the template is deactivated and instances are suspended

### Subscription authorization

`filterAuthorizedScopes()` must add a check: if a scope references a channel that is a personal assistant DM (`dm_target_type = 'assistant'`), the subscriber must be the channel's sole human member. Admin/owner role is NOT sufficient.

## 11. Data Flow

```text
User opens DM list
-> client requests POST /api/personal-assistant/bootstrap
-> API loads active template
-> API upserts personal assistant instance for current user
-> API upserts private DM channel for that instance
-> API ensures one default thread
-> API returns { agent, channel, thread }
-> client navigates to /admin/channels/:channelId
-> user sends message
-> normal thread message flow persists message
-> orchestration targets only that bound assistant instance
-> assistant replies in the same private thread
```

## 12. Folder/Package Structure

```text
api/
  src/
    services/
      personal-assistant.ts
    routes/ or index.ts
      personal-assistant endpoints
admin/
  src/
    facades/
      personal-assistant/
    pages/
      PersonalAssistantTemplatePage.tsx
packages/
  schemas/
    src/
      personal-assistant contracts
docs/
  plans/
    2026-04-14-personal-assistant-architecture.md
```

## 13. Architectural Rules

- One org-level template, one user-level instance, one private DM.
- Personal assistant instances are managed records, not normal user-created agents.
- Personal assistant instances are never team-owned.
- Personal assistant instances are never visible in shared team/channel discovery.
- Transcript privacy is enforced by backend membership and ownership checks, not by hidden UI.
- Memory retrieval for a personal assistant must be filtered by assistant instance and owner user.
- Realtime events for a personal assistant channel must be channel-scoped only.
- Admin template edit permission must be separate from transcript read permission.
- `Run` records for personal assistant agents are normal runs — no special handling needed, but they must not appear in other users' agent activity views.
- `TokenLedgerEvent` records must be attributed to the instance agent, not the template.
- Personal assistant agents must not be targetable by triggers, workflows, or cross-agent mailbox messages.
- `cloneAgentRecord()` must reject personal assistant agents as clone sources.
- `bindAgentToChannel()` must reject attempts to bind personal assistant agents to any channel other than their designated DM.
- `createAgentRecord()` must reject `agentKind = 'personal_assistant'` from external callers — only the bootstrap endpoint may create these.
- WebSocket `filterAuthorizedScopes()` must treat personal assistant channels as strictly channel-scoped — never include them in organization-scoped event broadcasts.

## 14. Anti-Patterns

- One shared assistant agent reused for every user.
- Storing per-user memory on the shared template.
- Letting admins read personal transcripts because they can edit the template.
- Treating assistant DMs as ordinary private group channels.
- Allowing generic agent bind/unbind flows to manage personal assistants.
- Sorting the assistant to the top in UI while leaving backend visibility broad.
- Using the personal assistant agent in workflow steps or trigger targets.
- Allowing cross-agent mailbox messages to reach personal assistants.
- Storing token usage under the template ID instead of the instance agent ID.
- Logging message content in audit logs for personal assistant conversations.
- Pre-provisioning instances at user signup — always lazy-create on first open.
- Treating `agentKind` as a UI-only label — it must be enforced at the service layer.

## 15. Scaling and Cost Notes

- Lazy-create instances on first open. Do not pre-provision for every user at signup.
- Reuse the same provider/model/tool policy from the template unless a later feature adds paid per-user overrides.
- Keep one instance per user, not one instance per session.
- Template versioning lets you roll prompt changes forward without mutating conversation history.

Upgrade triggers:

- add explicit per-user prompt extensions
- add break-glass support access
- add assistant reset / memory wipe flows
- add per-segment templates by org policy

## 16. Current Repo Gaps To Fix First

These are real issues in the current codebase that block a safe multi-user rollout:

- **`Agent` model has no ownership fields** (`api/prisma/schema.prisma`): No `agentKind`, `ownerUserId`, or `managedByTemplateId`. The model must be extended before personal assistants can be distinguished from shared agents at the database level.

- **`createAgentRecord()` does not stamp tenancy** (`api/src/services/agents.ts`): The function does not set `organizationId`, `projectId`, or `teamId` on the created agent record. Agent tenancy is too weak for multi-user isolation.

- **`isAgentAccessibleToActor()` is too permissive** (`api/src/services/agents.ts`): Gives owners/admins broad visibility to all org agents. For personal assistants, even org owners must not see another user's PA agent unless break-glass access is explicitly granted. This function needs an `agentKind` check before falling through to the owner path.

- **`cloneAgentRecord()` has no kind guard** (`api/src/services/agents.ts`): Must reject cloning of `personal_assistant` agents.

- **`bindAgentToChannel()` has no kind guard** (`api/src/services/agents.ts`): Must reject binding `personal_assistant` agents to channels other than their designated DM.

- **Organization-scoped realtime broadcasts** (`api/src/index.ts`): Thread message publishing emits events on organization-scoped WS topics alongside channel-scoped topics. For personal assistant channels, the org-scoped broadcast must be suppressed. Check `filterAuthorizedScopes()` in the WebSocket handler.

- **`findOrCreateDmChannel()` key format** (`api/src/services/channels.ts`): Currently uses `org:team:sorted([user1,user2])` format. Needs a new key format (`pa:org:user:agent`) for personal assistant DMs to avoid collisions with user-user DMs.

- **Admin `Personal` category is a UI label** (`admin/src/`): The "Personal" agent category is presentational only — no backend ownership enforcement. Personal assistant agents should not appear in any category listing. They need their own dedicated UI surface.

- **`Thought` model has no instance scoping** (`api/prisma/schema.prisma`, `api/src/services/thoughts.ts`): While `Thought.ownerId` exists, there is no guarantee that thought queries for personal assistants filter by the correct agent instance. Memory retrieval functions need an explicit `agentId` filter for PA contexts.

- **`createAgentTrigger()` has no kind guard** (`api/src/services/triggers.ts`): Must reject trigger creation for `personal_assistant` agents.

- **Workflow step agent references are unvalidated** (`api/src/services/workflows.ts`): `graphJson` step definitions can reference any agent ID. Must validate that referenced agents are not `personal_assistant` kind.

## 17. Recommended Rollout Order

1. **Schema migration** — Add `agentKind`, `ownerUserId`, `managedByTemplateId` to `Agent`. Create `PersonalAssistantTemplate` and `PersonalAssistantInstance` models. Add `dmTargetType`, `dmTargetAgentId` to `Channel`.
2. **Agent tenancy fix** — `createAgentRecord()` must stamp `organizationId`. Add `agentKind` checks to `isAgentAccessibleToActor()`, `cloneAgentRecord()`, `bindAgentToChannel()`.
3. **Service guards** — Add `agentKind` rejection guards to `createAgentTrigger()`, workflow step validation, and generic agent create/bind endpoints.
4. **Bootstrap endpoint** — `POST /api/personal-assistant/bootstrap` with transaction, idempotency, DM key format, and policy seed rules.
5. **Realtime scoping** — Suppress org-scoped WS broadcasts for personal assistant channels. Ensure `filterAuthorizedScopes()` rejects cross-user channel subscriptions.
6. **Admin template CRUD** — `GET/PUT/DELETE /api/admin/personal-assistant-template` endpoints + rotation endpoint.
7. **Admin template editor page** — New page in `/admin` for template name, prompt, provider/model/routing profile, tool policy.
8. **User DM entry** — Assistant-first entry in the DM list in `/admin`. Bootstrap call on first tap, navigate to returned channel.
9. **Memory scoping** — Filter `Thought` queries by `agentId` for personal assistant contexts. Ensure `ThoughtRecall` signals are instance-scoped.
10. **Policy seed rules** — Auto-create deny-all + owner-allow policy rules when bootstrapping an instance.
11. **Audit integration** — Log lifecycle events (create, suspend, reactivate, wipe) without transcript content.
12. **Token attribution** — Ensure `TokenLedgerEvent` records use instance `agentId`. Add aggregate PA usage view to admin tokens page.

## 18. Open Questions

- Should template updates apply immediately to all existing assistant instances, or only to new runs after a version bump is acknowledged?
- Do you want admins to have any break-glass support access to personal assistant threads, or strictly never?
- Do you want the personal assistant to support optional per-user prompt extensions later, or should it remain template-only?
- Should the personal assistant DM support multiple threads (like normal channels) or be a single-thread surface?
- Should suspended instances (from template deactivation) show a "your assistant is unavailable" message, or hide entirely from the DM list?
- Should the personal assistant have access to the full tool layer, or should tool access be restricted to a safe subset (e.g., no Bash, no FileWrite) by default?
- Should personal assistant instances be deletable by the user (self-service reset), or only by admins?
- Should the bootstrap endpoint be callable from the public API (for native app / MCP clients), or only from the admin web UI?
- How should the personal assistant interact with the existing `Plan` model — should it be able to create plans, and if so, are those plans visible to the user in the admin UI?

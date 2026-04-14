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

Suggested tables:

- `personal_assistant_templates`
  - `id`
  - `organization_id`
  - `name`
  - `system_prompt`
  - `provider`
  - `model`
  - `tool_policy`
  - `active`
  - `version`
  - `created_by_actor_id`
  - `updated_by_actor_id`
- `personal_assistant_instances`
  - `id`
  - `organization_id`
  - `user_id`
  - `agent_id`
  - `channel_id`
  - `template_id`
  - `template_version`
  - `status`
  - unique on `(organization_id, user_id)`

Add agent-level metadata:

- `agent_kind`: `shared` | `personal_assistant`
- `owner_user_id`: nullable for shared agents, required for personal assistants
- `managed_by_template_id`: nullable for shared agents

### Required endpoints

- `GET /api/personal-assistant`
  - returns the caller's assistant instance + DM channel if it exists
- `POST /api/personal-assistant/bootstrap`
  - find-or-create template-derived instance and private DM for current user
- `GET /api/admin/personal-assistant-template`
  - admin-only
- `PUT /api/admin/personal-assistant-template`
  - admin-only
- optional `POST /api/admin/personal-assistant-template/rotate`
  - applies template changes to existing instances under explicit migration rules

### Backend rules

- Instance creation must be idempotent and race-safe.
- Use a unique constraint on `(organization_id, user_id)`.
- The DM must also be unique and deterministic for that instance.
- The assistant DM must never be creatable through generic "bind agent to channel".
- Personal assistant agents must never be creatable through generic "create agent" UI.

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

## 7. Shared Packages

Add only contracts and validation here.

Allowed in `packages/schemas`:

- `PersonalAssistantTemplateSchema`
- `PersonalAssistantInstanceSchema`
- `BootstrapPersonalAssistantResponseSchema`
- `AgentKindSchema`
- `ChannelDmTargetTypeSchema`

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

## 9. Data Flow

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

## 10. Folder/Package Structure

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

## 11. Architectural Rules

- One org-level template, one user-level instance, one private DM.
- Personal assistant instances are managed records, not normal user-created agents.
- Personal assistant instances are never team-owned.
- Personal assistant instances are never visible in shared team/channel discovery.
- Transcript privacy is enforced by backend membership and ownership checks, not by hidden UI.
- Memory retrieval for a personal assistant must be filtered by assistant instance and owner user.
- Realtime events for a personal assistant channel must be channel-scoped only.
- Admin template edit permission must be separate from transcript read permission.

## 12. Anti-Patterns

- One shared assistant agent reused for every user.
- Storing per-user memory on the shared template.
- Letting admins read personal transcripts because they can edit the template.
- Treating assistant DMs as ordinary private group channels.
- Allowing generic agent bind/unbind flows to manage personal assistants.
- Sorting the assistant to the top in UI while leaving backend visibility broad.

## 13. Scaling and Cost Notes

- Lazy-create instances on first open. Do not pre-provision for every user at signup.
- Reuse the same provider/model/tool policy from the template unless a later feature adds paid per-user overrides.
- Keep one instance per user, not one instance per session.
- Template versioning lets you roll prompt changes forward without mutating conversation history.

Upgrade triggers:

- add explicit per-user prompt extensions
- add break-glass support access
- add assistant reset / memory wipe flows
- add per-segment templates by org policy

## 14. Current Repo Gaps To Fix First

These are real issues in the current codebase that block a safe multi-user rollout:

- `Agent` has no ownership field, so "personal" is not enforceable in the database.
- `createAgentRecord()` does not stamp `organizationId`, `projectId`, or `teamId`, so agent tenancy is currently too weak for this feature.
- `isAgentAccessibleToActor()` gives owners broad visibility to org agents; that is incompatible with "nobody else can see my assistant chat".
- thread message publishing currently includes organization-scoped realtime notifications alongside channel-scoped notifications; personal assistant message events must be channel-scoped only.
- the admin `Personal` category is currently just a UI label and does not map to creator ownership.

## 15. Recommended Rollout Order

1. Add schema fields and migrations for template, instance, ownership, and assistant DM metadata.
2. Stamp agent tenancy and ownership correctly at creation time.
3. Add backend bootstrap endpoint for personal assistant find-or-create.
4. Lock down visibility rules for agents, threads, and realtime scopes.
5. Add admin template editor.
6. Add assistant-first DM entry in `/admin`.
7. Prevent generic bind/clone/team flows from touching personal assistants.
8. Add memory scoping and reset semantics.

## 16. Open Questions

- Should template updates apply immediately to all existing assistant instances, or only to new runs after a version bump is acknowledged?
- Do you want admins to have any break-glass support access to personal assistant threads, or strictly never?
- Do you want the personal assistant to support optional per-user prompt extensions later, or should it remain template-only?

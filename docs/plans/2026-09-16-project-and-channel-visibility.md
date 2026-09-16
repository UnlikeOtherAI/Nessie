# Project and channel visibility

Date: 2026-09-16  
Branch: `claude/visibility-spec`

## Why this exists

Today three symptoms in `#outreach` had one cause: the code tests for the literal
`owner` role and treats `admin` as an ordinary member.

- `packages/team-admin/src/channel-agent-authority.ts` requires an
  **organisation owner** plus channel membership before it will draw the "Add"
  control for agents.
- `GET /api/users` (`api/src/routes/users.ts:74`) shapes the response on
  `roles.includes('owner')`; everyone else, including admins, gets
  `toMemberDirectoryView`. The members popup then derives participation
  client-side from this field because there is no channel roster endpoint.
- `admin/src/lib/channel-compose-recipients.ts` drops ordinary agents unless
  `isOwner` is true, so an admin starting a direct message saw no shared agents.

Separately, there is no API route to delete an agent. The members popup offers a
one-tap "duplicate" button that creates an agent row no UI and no endpoint can
remove; one such row had to be deleted directly from the production database
today.

## Settled product decisions

These are input, not open questions.

1. An organisation **admin** has **owner-level management reach** over anything
   they can already see: add and remove people, place and unplace agents, edit
   and delete agents, rename/archive/delete projects and channels. Channel or
   project membership is not required for management, and management actions must
   **not** silently make the admin a member.
2. **Management is not participation.** An admin who is not a member of a
   channel must not be offered a message composer. They can administer the room
   without being able to speak in it.
3. Projects and channels each get a user-selectable visibility choice at
   creation time: `public` or `protected`.
   - `public` — anyone in the organisation may join. Contents are browsable
     without joining. Sending a message requires joining. Joining is self-service.
   - `protected` — rendered with a lock. Contents are **not** browsable. A
     non-member sees only a simplified overview: name and member list. Getting in
     is not self-service.
4. A `protected` project or channel is discoverable by **search**. It is not
   invisible. It appears in results with a lock marker, and opening it gives the
   simplified overview (name + members) and nothing else. It must **not** appear
   in the ordinary browse listing for a non-member.
5. Agent delete must be reachable from **Admin → Agents** for whoever may edit
   that agent.
6. **Existing projects backfill to `public`.** Every organisation member gains
   the full record of every existing project on deploy day. This is a deliberate
   disclosure expansion; it is stated here so it is not a surprise.
7. **An org admin MAY add themselves to a protected project or channel.** This
   deliberately reverses the Slack/Teams rule currently stated in
   `docs/standards/team-model.md:176-183` and
   `packages/team-admin/src/resource-authority.ts:6-27,124-128`.
8. **Agent delete is a soft delete.** The row stays for audit history, but the
   transaction must revoke every capability that would otherwise remain live.

## Visibility model

`ChannelVisibility` stays a **three-value enum**:

```prisma
enum ChannelVisibility {
  public
  protected
  private
}
```

`private` is **not** dropped. Six migrations' CHECK constraints and two PL/pgSQL
functions require the literal `'private'::"ChannelVisibility"` for every system
DM, Personal-Assistant home, agent home, external-agent DM and global-agent DM:
`api/prisma/migrations/20260415110000_add_personal_assistant_system_fields`,
`20260902150000_channel_system_type_surfaces`,
`20260902170000_external_agent_surface_invariants`,
`20260902180000_agent_email_channel_surface`,
`20260902190100_global_agent_foundation`, `20260830300000_private_agent_homes`,
and `20260831010000_personal_assistant_channel_presences`. Postgres cannot drop
an enum value while dependent objects reference it; even re-creating the type
would require re-issuing every CHECK and trigger in the same transaction.

The three values are therefore partitioned as follows:

- `public` — user-selectable. Any organisation member can see the room exists
  and, for channels, browse contents without joining.
- `protected` — user-selectable. Non-members learn the room exists only through
  search or a direct URL, and see only name + members.
- `private` — **reserved for DM and system-managed channels only**. Never offered
  in the create form, never user-selectable, never discoverable, never returned
  by any new read. It stays because the database requires it.

Every new surface that exposes a project or channel to non-members must be gated
on `type = 'standard' AND systemChannelType IS NULL AND NOT isGroupDm`, with a
check and a test. A DM must answer `channel_not_found` to any outsider, and must
never appear in search.

`protected` is already reachable today: `CreateChannelDialog` offers it and
`worker/src/run/pa-tools/provisioning.ts:71` accepts it. Pre-existing `protected`
rows behave like any other protected standard channel after this change.

## Authority model

The rule, stated once: **membership decides participation; org owner/admin
standing decides management outside membership.**

Management means: rename, archive, delete, add/remove members, change
visibility, and (for channels) place/unplace agents. Participation means: see
content, send messages, join public rooms.

| Actor | Surface | What they may read | Join / participate | Manage |
|---|---|---|---|---|
| Organisation owner | Any standard project or channel in the org | Full metadata and content | Full if they choose to join; composer only when a member | Always, including protected rooms they never joined |
| Organisation admin | Any standard project or channel they can see | Full metadata; content only when a member (composer suppressed otherwise) | Only after an explicit member add; until then no composer | Always, including protected rooms they never joined; actions must not auto-add them as members |
| Project or channel member | That project or channel | Full metadata and content | Full: read, write, mention, react | Rename, archive, delete, add/remove members; **not** agent placement (still owner/admin) |
| Organisation member, neither owner/admin nor member | Public project or channel | Full content (browse without joining) | May self-join; may not send until joined | Nothing |
| Organisation member, neither owner/admin nor member | Protected project or channel | Simplified overview only: name, visibility, member list | Not self-service; no composer | Nothing |

A **team** role (team owner/admin) outside a project or channel still grants
nothing, per `docs/standards/team-model.md`.

## Wire contract for protected resources

A non-member opening a `protected` project or channel receives a **limited**
shape. The shape is built field-by-field and parsed through a `.strict()` schema
so a newly added field cannot leak to an outsider by default.

`locked` is **not** a wire field. The client derives the lock marker from
`visibility === 'protected'`. The previous spec put `locked: z.literal(true)` on
the `limited` arm, but the directory's `limited` arm is also used for public
projects seen by non-members, so a literal `true` would throw.

### Protected project (non-member)

Reuse the existing `ProjectDirectoryEntrySchema` pattern, extended with
`visibility`.

```ts
ProjectDirectoryEntrySchema = z.discriminatedUnion('access', [
  z.object({
    access: z.literal('limited'),
    id: ProjectIdSchema,
    name: NonEmptyStringSchema,
    description: z.string().nullable(),
    visibility: z.enum(['public', 'protected']),
    members: z.array(ProjectDirectoryMemberSchema),
  }).strict(),
  z.object({
    access: z.literal('full'),
    id: ProjectIdSchema,
    name: NonEmptyStringSchema,
    description: z.string().nullable(),
    visibility: z.enum(['public', 'protected']),
    members: z.array(ProjectDirectoryMemberSchema),
    project: ProjectRecordSchema,
    viewerIsMember: z.boolean(),
  }).strict(),
])
```

`ProjectRecordSchema` gains an **optional** `visibility` field. It does **not**
gain `viewerIsMember`; that belongs on the directory entry where a viewer exists.
`ProjectRecordSchema` is produced in viewer-less contexts (`POST /api/projects`,
`POST /api/teams`, the Agent Designer's `project_create` / `team_create` tools),
so a viewer-relative field is meaningless there.

### Protected channel (non-member)

Add a matching `ChannelDirectoryEntrySchema`:

```ts
ChannelDirectoryEntrySchema = z.discriminatedUnion('access', [
  z.object({
    access: z.literal('limited'),
    id: ChannelIdSchema,
    label: NonEmptyStringSchema,
    description: z.string().nullable(),
    visibility: z.enum(['public', 'protected']),
    members: z.array(ProjectDirectoryMemberSchema),
    projectName: NonEmptyStringSchema,
    teamName: NonEmptyStringSchema,
  }).strict(),
  z.object({
    access: z.literal('full'),
    // ordinary ChannelRecord, now including viewerIsMember
  }).strict(),
])
```

A non-member who opens a protected channel sees the limited row. A member, or an
org owner/admin, sees the full `ChannelRecord`. The full record carries
`viewerIsMember: boolean` so the client can suppress the composer for admins who
are managing but not participating.

### What is deliberately omitted from the limited shape

No counts, no avatar, no boards/tasks/fields/sources/iterations, no channels, no
settings, no message history, no unread counts, no `viewerCanManage`, no
`memberRole`. Only the facts needed to know the room exists and whom to ask to be
added.

## Project visibility

Add a new enum and column:

```prisma
enum ProjectVisibility {
  public
  protected
}

model Project {
  // ... existing fields
  visibility ProjectVisibility @default(public)
}
```

Migration backfills every existing project to `public`. This is the product
decision in §6; it grants every organisation member the full project record and
browsable contents of every existing project on deploy day.

## Splitting project read from project modify

`canModifyProject` is currently defined as exactly `isProjectAccessibleToUser`
(`packages/team-admin/src/resource-authority.ts:34-39`). Widening the read to let
non-members see public projects would therefore also let them edit boards,
fields, sources, iterations and watchers.

Introduce a new predicate:

```ts
resolveProjectAccess(viewer, project) -> 'none' | 'limited' | 'full'
```

- `'none'` — caller gets `404 PROJECT_NOT_FOUND`.
- `'limited'` — caller is an org member but not a project member, and the project
  is `public` (or the caller is an admin viewing a protected project they do not
  manage). Return the limited directory shape.
- `'full'` — caller is a project member, or an org owner/admin.

`canModifyProject` keeps its current definition: project members, or org
owner/admin. It is **not** replaced by `resolveProjectAccess`. Every existing
write route (`boards`, `task-fields`, `iterations`, `board-sources`, etc.) and
`requireProjectModifier` continue to use `canModifyProject` unchanged.

Add a test that a non-member of a **public** project is refused `PATCH
/api/projects/:projectId` and a board write.

## Route changes

| Route | Before | After |
|---|---|---|
| `GET /api/users` | Full `UserRecord` only when `roles.includes('owner')`; admins get narrowed `toMemberDirectoryView` | Unchanged. Do not give admins the owner `UserRecord`: the full list discloses other people's DMs (`api/src/services/users.ts:114-117`). Fix the popup by adding a channel roster instead. |
| `GET /api/agents` | `isOwner` decides how much of the list to return | `isAdminActor` decides; admins see the same list owners do |
| `POST /api/agents/:agentId/bindings` | `requireOwner` + `getChannelIfMember` | `requireAdminActor` + `canManageChannelAgents` (admin need not be a member) |
| `DELETE /api/agents/:agentId/bindings/:channelId` | `requireOwner` + `getChannelIfMember` | `requireAdminActor` + `canManageChannelAgents` |
| `GET /api/channels` | Public **or** member channels | Public channels, plus protected channels the viewer is a member of; protected non-member channels excluded even for admins |
| `GET /api/channels/:channelId` *(new)* | Not present | Direct read. Member or admin → full `ChannelRecord`. Non-member org member on protected standard channel → limited `ChannelDirectoryEntry`. Non-member on public → full record with `viewerIsMember: false`. DM or system channel → `channel_not_found` for outsiders. |
| `GET /api/channels/:channelId/members` *(new)* | Not present | Channel roster. Returns the member list for anyone who may see the channel (member, owner, admin). Outsiders get `channel_not_found`. |
| `POST /api/channels/:channelId/join` | Public channels only | Public channels only; protected channels refuse with `CHANNEL_JOIN_FORBIDDEN` |
| `POST /api/channels/:channelId/members` | `canModifyChannel` (member, or admin on public) | `canModifyChannel` extended to allow admins on protected standard channels they can see |
| `PATCH /api/channels/:channelId` | Label/topic/description only | Also accepts `visibility` (`public`/`protected`). Update `UpdateChannelBodySchema.refine` so `{ visibility }` alone is valid. |
| `POST /api/channels/conversations` | `requireOwner` when `agentIds` present | `requireAdminActor` when `agentIds` present, matching the new address-book gate |
| `GET /api/projects` | Projects the caller is a member of, plus all projects for owner/admin | Public projects are now listed for every org member; protected projects listed only for members and admins |
| `GET /api/projects/directory` | Every live project, limited for non-members/full for members and admins | Excludes protected projects for non-members (admins still see all); public projects remain limited for non-members |
| `GET /api/projects/:projectId` | Member or admin only; 404 for everyone else | Public project → full record for any org member; protected project → limited `ProjectDirectoryEntry` for non-members; full record for members/admins |
| `GET /api/projects/:projectId/members` | Member or admin only | Included in the limited overview for non-members; unchanged authority for the standalone route |
| `PATCH /api/projects/:projectId` | `requireProjectModifier` | Also accepts `visibility` (`public`/`protected`). `canModifyProject` unchanged. |
| `POST /api/projects` | `name` + `teamId` | Also accepts `visibility` (`public`/`protected`), defaulting to `public`. Use a named schema. |
| `GET /api/search` | Not present | **Deferred.** Discovery for protected rooms is by direct URL in phase 1; a server search endpoint will ship in phase 2 with its own contract. |
| `DELETE /api/agents/:agentId` *(new)* | Not present | Soft-delete the agent for callers who may edit it. See agent delete contract below. |

`canModifyChannel` (`packages/team-admin/src/resource-authority.ts:76-130`)
changes from:

```ts
return isOrganizationAdmin && channel.visibility === 'public' ? { channel } : null
```

to:

```ts
return isOrganizationAdmin && channel.type === 'standard'
  && channel.systemChannelType === null && !isGroupDm(channel)
  ? { channel }
  : null
```

An admin may manage any **standard, non-system, non-group-DM** channel they can
already see. The "can see" check is enforced by the read path: protected
channels do not appear in the browse list, but an admin who reaches one by
direct URL or admin tooling may manage it.

`actorCanSee` (`api/src/services/channel-members.ts:60`) currently returns
`actorIsMember || channel.visibility === 'public'`. For admin non-members on a
protected standard channel, the route must see the channel so it can be managed,
so `actorCanSee` becomes `actorIsMember || channel.visibility === 'public' ||
isAdminActor(actorContext)` **for standard non-system non-group-DM channels
only**. For every other non-member, the repo's rule stays: `channel_not_found`,
never 403.

`canManageChannelAgents` (`packages/team-admin/src/channel-agent-authority.ts`)
changes from "organisation owner + channel member" to "organisation owner or
admin + able to see the channel (member, or admin on any standard non-system
non-DM channel)". This requires plumbing an `isOrganizationAdmin` flag through
`ChannelRecordViewer` and rewriting the contract comment in
`packages/schemas/src/team-records.ts:97-113`.

## Admin surface changes

### Create forms

- `admin/src/components/shared/CreateProjectDialog.tsx` adds a **Visibility**
  field with options `Public` / `Protected`, default `Public`.
- `admin/src/components/shared/CreateChannelDialog.tsx` removes the `private`
  option and keeps only `public` / `protected`.
- `worker/src/run/pa-tools/provisioning.ts:71` and
  `packages/runtime/src/builtin-channel-tools.ts:164` change their LLM tool
  schemas from `['public','protected','private']` to `['public','protected']`.
  The seeded copy in `admin/e2e/marketing-shots/snapshot.sql:2673` must also be
  updated.

### Lock affordance

- Protected projects and channels render a lock marker in directory rows and the
  simplified overview. The marker is derived from `visibility === 'protected'`
  on the client; the wire does not carry a separate `locked` field.
- The project directory row and channel list row for a protected non-member item
  show the lock and the member list, not counts or content previews.

### Simplified overview

- Opening a protected project as a non-member lands on a read-only overview:
  name, description, visibility, member list. No tabs, no boards, no channels,
  no settings actions.
- Opening a protected channel as a non-member lands on the same kind of overview:
  name, member list. No message feed, no composer, no tabs.
- An admin who is not a member sees the **full management view** (settings gear,
  members popup, channel info) but still no composer. The server returns the full
  record; message/thread routes remain gated by membership.

### Composer suppression

- `admin/src/components/features/channels/channel-room-controls.ts` and
  `admin/src/pages/channels/ChannelConversationSurface.tsx` suppress the composer
  when `viewerIsMember === false`.
- A public channel the viewer has not joined shows a **Join** action and a
  read-only feed; the composer appears only after joining.
- A protected channel the viewer has not joined shows no Join and no composer.
- An admin who is not a member also gets no composer, even though they can open
  settings and manage members.

### Agent delete control

- `admin/src/components/features/agents/AgentListRow.tsx` adds a delete action
  for agents the viewer may edit (`canEditAgent`).
- `admin/src/pages/AgentsPage.tsx` / `admin/src/components/features/agents/AgentsList.tsx`
  wire a confirmation dialog.
- System-managed agents never show a delete action.

### Address book

- `admin/src/lib/channel-compose-recipients.ts` changes
  `selectAddressableAgents(..., { isOwner })` to `selectAddressableAgents(...,
  { isAdmin })`, matching the new server-side authority. The corresponding
  `POST /api/channels/conversations` gate changes from `requireOwner` to
  `requireAdminActor` for requests that include `agentIds`.

## Agent delete contract

### Authority

`DELETE /api/agents/:agentId` is allowed for exactly the same callers who may
edit the agent, **with org admin included**.

`packages/runtime/src/agent-edit-authority.ts:105-118` currently computes owner
strictly as `role === 'owner'`, so an admin is refused. Change it to admit
organisation owner **or admin** for person-owned and team-owned agents; private
agents remain live-owner-only. Update `docs/standards/agent-ownership.md` in the
same turn.

The UI shows the delete action on `Admin → Agents` only when `canEditAgent` is
true.

### Soft delete

Add `Agent.deletedAt DateTime?`. Agents carry audit history (runs, messages,
approvals) that must not disappear when the configuration is removed.

- `buildVisibleAgentWhere` (`packages/db/src/agent-visibility.ts:54-82`) gains
  `deletedAt: null`. `packages/db/src/knowledge-space-visibility.ts:28` composes
  this predicate, so it inherits the filter automatically. The previous spec
  named the wrong path; it is in `packages/db`, not `packages/runtime/src/agent-access.ts`.
- The route returns `204` on success.
- Emit audit `agent.deleted` and broadcast `agent.deleted` over realtime so the
  agents list removes the row without a refresh. `AgentRecordSchema` does **not**
  expose `deletedAt`; the delete is signaled by removal.

### Revocation

Because the row is kept, the route must explicitly revoke every live capability
in one transaction:

1. **Bindings** — delete every `AgentBinding` row for this agent.
2. **Triggers** — delete every `AgentTrigger` row for this agent.
3. **Runs** — cancel every queued and in-flight run where `run.agentId = agent.id`
   and `run.status` is not terminal. Use the existing run-cancellation service.
   Refuse to start new runs for a soft-deleted agent at run admission.
4. **Auto-created "<name> — Documents" knowledge space** — set
   `KnowledgeSpace.ownerAgentId` to `null` so the `ON DELETE NO ACTION` FK is not
   violated. The space and its pages remain under the project; a later cleanup
   job can remove empty ones.
5. **Mailbox** — `AgentMailbox.agentId` is `@unique` and non-null, so the agent
   keeps its address and inbound mail path. Disconnect or disable the mailbox so
   inbound mail no longer reaches the deleted agent. The exact mechanism (set
   `deletedAt` on `AgentMailbox`, null the address, or reject inbound) is left to
   implementation; the requirement is that inbound mail stops.
6. **Grants** — delete or revoke `SendAuthorizationGrant`, `ToolGrant`,
   `ExecutorAgentOperationGrant`, `BrowserPersonalAccessGrant` and
   `MailboxConnectionAgentAccess` rows for this agent.
7. **Child agents** — leave `parentAgentId` pointing at the deleted parent for
   audit. The soft delete preserves the row.
8. **Core documents** — left intact; they are part of the audit trail.

A hard delete is **not supported**. Three FKs are `onDelete: Restrict`
(`ExecutorPrivateAssignment`, `ExecutorAgentOperationGrant`,
`ExecutorAvailabilityCandidate`) and `AgentBrowser` is `NoAction`, so a hard
delete would fail regardless of order. The audit loss of cascading `Run` and
`Task` deletions makes soft delete the only viable option.

## Standards files to update

- `docs/standards/team-model.md:176-186` — rewrite rule 3 to admit admin
  management of protected rooms and admin self-add.
- `docs/standards/team-model.md:201-209` — split project read from modify; state
  that `canModifyProject` keeps its membership-or-org-admin definition.
- `docs/standards/team-model.md:271-279` — update "What a person outside a
  project may see" to reflect that protected projects are excluded from the
  directory for non-members, and that existing projects are public.
- `packages/team-admin/src/resource-authority.ts:6-27` and `:124-128` — rewrite
  the header comment and the admin arm to match the new rule.
- `packages/schemas/src/team-records.ts:97-113` — rewrite the
  `viewerCanManageAgents` comment to say owner-or-admin, not owner-only.
- `docs/standards/agent-ownership.md` — update the edit-authority paragraph to
  include organisation admin alongside owner.

## Reader inventory

The following sites must change because they explicitly handle `private`, write
`visibility`, or expose it to a model:

| File | What to do |
|---|---|
| `api/prisma/schema.prisma` | Keep `ChannelVisibility { public, protected, private }`. Add `ProjectVisibility { public, protected }` and `Project.visibility`. Add `Agent.deletedAt`. |
| `packages/schemas/src/team-records.ts:66` | Keep `private` in `ChannelRecordSchema.visibility`. Add optional `visibility` to `ProjectRecordSchema`. Add `viewerIsMember` to `ChannelRecordSchema`. Add `ChannelDirectoryEntrySchema`. |
| `packages/schemas/src/memory.ts:19-20` | Keep `ChannelVisibilitySchema` as three values; it reflects storage, not the user-selectable set. |
| `packages/team-admin/src/channel-create.ts:208,214` | Keep accepting `private` internally for DM/system use; do not offer it to users. |
| `worker/src/run/pa-tools/provisioning.ts:71,86-91` | Tool schema drops `private`; default for `system_agent` home stays `private`. |
| `packages/runtime/src/builtin-channel-tools.ts:121-128,164` | Tool schema and prose drop `private`; seeded copy in `admin/e2e/marketing-shots/snapshot.sql:2673` must match. |
| `admin/src/components/shared/CreateChannelDialog.tsx:137` | Remove the `<option value="private">`. |
| `admin/src/components/features/projects/project-dashboard-data.ts:18` | Add `visibility` handling. |
| `packages/browser-cloud/src/private-browser-home.ts:67-68` | This positive `=== 'private'` test breaks after a backfill. Keep it as-is: the channels it guards remain `private` (DM/system), and the new gating guarantees no standard channel stays `private`. |
| `simulation/lib/api.ts:96,128`, `simulation/lib/actions.ts:177` | Update fixtures if they create standard channels with `private`. |
| `admin/e2e/connected-mail/fixtures.mjs:112`, `admin/e2e/disclosure/fixture.mjs:48,55`, `admin/e2e/agent-conversations/fixture.mjs:56,84`, `admin/e2e/marketing-shots/snapshot.sql:168-174`, `packages/team-admin/test/project-structure-db.test.ts:203`, `packages/memory/test/capture.test.ts:242,276` | Update only if they model standard channels; DM/system fixtures stay `private`. |
| `api/src/contracts/team.ts:25-37` | Add `visibility` to `UpdateChannelBodySchema` and extend the `.refine`. |
| `api/src/contracts/team.ts:83-92` | Add `CreateChannelBodySchema.visibility` with `['public','protected']`. |
| `api/src/routes/projects.ts:165` | Replace inline `z.object({ name, teamId })` with a named `CreateProjectBodySchema` including optional `visibility`. |
| `api/src/contracts/team.ts:94-107` | Add `visibility` to `UpdateProjectBodySchema` and extend the `.refine`. |

The following readers are **safe** because they key on `=== 'public'` or `!==
'public'` and treat all non-public channels the same way; they need only the
code-level invariant that a DM/system channel is never misidentified as a
standard channel:

- `worker/src/run/pa-tools/access.ts:175-182` (`buildVisibleChannelWhere`)
- `api/src/services/message-search.ts:70`
- `api/src/lib/request-helpers.ts:342-350` (`getVisibleChannel`)
- `api/src/services/channels.ts:209` (`viewerMayModify`)
- `packages/team-admin/src/channel-members.ts:60` (`loadChannelForMemberChange`)
- `api/src/services/channel-mention-audience.ts`, `api/src/services/realtime-events.ts`
- `api/src/services/message-delivery.ts:182,230`, `packages/memory/src/capture.ts`,
  `packages/memory/src/consolidate.ts`, `packages/memory/src/scopes.ts`,
  `packages/runtime/src/disclosure-access.ts`, `packages/runtime/src/disclosure-grants.ts`,
  `packages/runtime/src/run-disclosure.ts`, `worker/src/run/execute/scopes.ts`,
  `worker/src/run/execute/prompt.ts`, `worker/src/run/execute/history-recall.ts`,
  `worker/src/run/execute/private-conversation-lineage.ts`

## Test plan

### Unit / service tests

- `packages/team-admin/test/access-checks.test.ts` (or a new focused test):
  - `canModifyChannel` returns the channel for an admin who is not a member of a
    protected standard channel.
  - `canModifyChannel` still returns `null` for an ordinary member outside a
    protected channel.
  - `canModifyChannel` returns `null` for an admin on a system channel or DM.
  - `canManageChannelAgents` returns true for an admin who is not a member of a
    standard channel.
  - `canManageChannelAgents` returns false for an admin on a system channel.
  - `resolveProjectAccess` returns `'limited'` for a non-member of a public
    project and `'none'` for a non-member of a protected project.
  - `canModifyProject` returns `false` for a non-member of a public project.
- `packages/team-admin/test/channel-agent-authority.test.ts`: update existing
  cases to cover owner and admin.
- `packages/db/test/agent-visibility.test.ts`: verify `buildVisibleAgentWhere`
  excludes soft-deleted agents.

### API tests

Use real package test paths:

- `api/test/channel-member-authority.test.ts`:
  - Admin can bind/unbind an agent in a protected channel without being a member.
  - Non-member ordinary user cannot join a protected channel.
  - Non-member ordinary user gets `access: 'limited'` from
    `GET /api/channels/:channelId` for a protected standard channel.
  - Admin gets full `ChannelRecord` from `GET /api/channels/:channelId` for a
    protected standard channel, with `viewerIsMember: false`.
  - `GET /api/channels` does not return protected non-member channels.
  - DM outsiders get `channel_not_found` from `GET /api/channels/:channelId`.
  - DM and system channel never appear in search.
- `api/test/project-equal-rights-routes.test.ts`:
  - `GET /api/projects` returns public projects for non-member org members.
  - `GET /api/projects/directory` excludes protected projects for non-members.
  - `GET /api/projects/:projectId` returns limited shape for a protected project
    non-member.
  - Non-member of a public project is refused `PATCH /api/projects/:projectId`
    and a board write.
  - Admin can patch a protected project's visibility and members without being a
    member.
- A new `api/test/agent-delete-routes.test.ts`:
  - `DELETE /api/agents/:agentId` refuses unauthorised callers.
  - Soft delete removes the agent from listings, deletes bindings, deletes
    triggers, cancels queued and running runs, detaches the auto-created
    knowledge space owner, and revokes grants.
  - System-managed agent delete returns `SYSTEM_AGENT_IMMUTABLE`.
- `api/test/uoa-identity-users-route.test.ts`:
  - Admin still receives `toMemberDirectoryView`, not the owner `UserRecord`.
  - Ordinary member still receives the directory view.
  - New `GET /api/channels/:channelId/members` returns the roster for members and
    admins, `channel_not_found` for outsiders.

### Browser / e2e tests

- `pnpm --filter @nessie/admin test:e2e:channel-agent-controls`: extend the
  existing fixture to cover the admin case — the members popup shows the agent
  "Add" control for an admin who is not a channel member.
- `pnpm --filter @nessie/admin test:e2e:project-usability`: add a fixture that
  creates a protected project, verifies the create-form visibility choice, and
  checks that a non-member sees the simplified overview while a member sees the
  full project.
- If a new dedicated browser fixture is needed for protected channels, follow
  the three-edit rule from `CLAUDE.md`: add the Vite input behind a
  `NESSIE_<NAME>_E2E_FIXTURE` flag, set the flag in
  `.github/workflows/browser-suites.yml`, and list it under `@nessie/admin#build`
  `env` in `turbo.json`.
- Run the on-demand **Browser Suites** workflow (`gh workflow run
  browser-suites.yml --ref <branch>`) for any branch that touches the admin shell,
  navigation, or these surfaces, because the browser suites are not required
  checks.

## Migration and rollout

1. **Prisma migration**
   - Add `Project.visibility ProjectVisibility @default(public)`.
   - Backfill existing projects to `public`.
   - Add `Agent.deletedAt DateTime?`.
   - Do **not** alter `ChannelVisibility`. Keep `{ public, protected, private }`.

2. **Code deploy order**
   - Deploy the API first. The `Project.visibility` column and `Agent.deletedAt`
     column must exist before code writes or reads them.
   - Deploy the admin after the API supports the new fields and routes.

3. **Behaviour for existing data**
   - Existing **public** channels remain public and visible to all organisation
     members.
   - Existing **private** channels remain `private` (DM and system channels).
     No backfill changes their storage value.
   - Existing **projects** become `public`, granting every organisation member
     the full record and browsable contents on deploy day.
   - No existing member loses access to anything they could already open.
   - No existing admin gains the ability to read message history of a protected
     room they are not in; they gain only management metadata.

4. **Search**
   - `GET /api/search` is not in phase 1. Protected projects and channels are
     discoverable by direct URL only until the search endpoint ships.

## Open questions

1. **What is the exact mailbox revocation shape on agent soft-delete?**
   The requirement is that inbound mail to a soft-deleted agent stops. Options:
   soft-delete the `AgentMailbox` row, null its address, or reject inbound in the
   route. The choice depends on whether the address must be released for reuse.

2. **Should a non-member admin receive `lastMessageAt` and `unreadCount` in a
   full `ChannelRecord`?**
   These fields are derived from message history. The spec recommends returning
   the full management record to admins, which currently includes them. If they
   are considered participation metadata rather than management metadata, they
   should be omitted from the admin non-member response; this needs a product
   call.

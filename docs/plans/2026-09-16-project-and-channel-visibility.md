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
  `toMemberDirectoryView`, which narrows each person's `channelIds` to channels
  the viewer shares. That is why a real member rendered as "not a member" and the
  popup offered an Add button.
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
3. Projects and channels each get a visibility choice at creation time:
   `public` or `protected`.
   - `public` — anyone in the organisation may join. Contents are browsable
     without joining. Sending a message requires joining. Joining is self-service.
   - `protected` — rendered with a lock. Contents are **not** browsable. A
     non-member sees only a simplified overview: name and member list. Getting in
     is not self-service.
   The same rule applies to channels, including shared channels.
4. A `protected` project or channel is still discoverable by **search**. It is
   not invisible. It appears in results with a lock marker, and opening it gives
   the simplified overview (name + members) and nothing else. It must **not**
   appear in the ordinary browse listing for a non-member.
5. Agent delete must be reachable from **Admin → Agents** for whoever may edit
   that agent.

## Authority model

The rule, stated once: **membership decides participation; org owner/admin
standing decides management outside membership.**

Management means: rename, archive, delete, add/remove members, change
visibility, and (for channels) place/unplace agents. Participation means: see
content, send messages, join public rooms.

| Actor | Surface | What they may read | Join / participate | Manage |
|---|---|---|---|---|
| Organisation owner | Any project or channel in the org | Full metadata and content | Full if they choose to join; composer only when a member | Always, including protected rooms they never joined |
| Organisation admin | Any project or channel they can see | Full metadata; content only when a member (composer suppressed otherwise) | Only after an explicit member add; until then no composer | Always, including protected rooms they never joined; actions must not auto-add them as members |
| Project or channel member | That project or channel | Full metadata and content | Full: read, write, mention, react | Rename, archive, delete, add/remove members; **not** agent placement (still owner/admin) |
| Organisation member, neither owner/admin nor member | Public project or channel | Full content (browse without joining) | May self-join; may not send until joined | Nothing |
| Organisation member, neither owner/admin nor member | Protected project or channel | Simplified overview only: name, visibility, member list | Not self-service; no composer | Nothing |

A **team** role (team owner/admin) outside a project or channel still grants
nothing, per `docs/standards/team-model.md`.

## Wire contract for protected resources

A non-member opening a `protected` project or channel receives a **limited**
shape. The shape is built field-by-field and parsed through a `.strict()` schema
so a newly added field cannot leak to an outsider by default.

### Protected project (non-member)

Reuse the existing `ProjectDirectoryEntrySchema` pattern, extended with the
visibility and lock marker.

```ts
ProjectDirectoryEntrySchema = z.discriminatedUnion('access', [
  z.object({
    access: z.literal('limited'),
    id: ProjectIdSchema,
    name: NonEmptyStringSchema,
    description: z.string().nullable(),
    visibility: z.enum(['public', 'protected']),
    members: z.array(ProjectDirectoryMemberSchema),
    locked: z.literal(true),
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

`ProjectRecordSchema` gains `visibility` and `viewerIsMember`.

### Protected channel (non-member)

Add a matching `ProtectedChannelSchema` / `ChannelDirectoryEntrySchema`:

```ts
ChannelDirectoryEntrySchema = z.discriminatedUnion('access', [
  z.object({
    access: z.literal('limited'),
    id: ChannelIdSchema,
    label: NonEmptyStringSchema,
    description: z.string().nullable(),
    visibility: z.enum(['public', 'protected']),
    members: z.array(ProjectDirectoryMemberSchema), // same small member projection
    projectName: NonEmptyStringSchema,
    teamName: NonEmptyStringSchema,
    locked: z.literal(true),
  }).strict(),
  z.object({
    access: z.literal('full'),
    // ... ordinary ChannelRecord, now including viewerIsMember
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

## What happens to `Channel.visibility`

The schema enum already declares three values:

```prisma
enum ChannelVisibility {
  public
  protected
  private
}
```

`protected` is **not** a third state. It is the new canonical name for what the
product now calls a non-public channel. `private` is removed.

Migration:

1. Backfill every row with `visibility = 'private'` to `'protected'`.
2. Alter the enum to contain only `public` and `protected`.
3. Update `ChannelRecordSchema`, `CreateChannelBodySchema`,
   `UpdateChannelBodySchema`, and the admin `CreateChannelDialog` so that
   `private` is no longer an accepted value.

Existing public channels stay public. Existing private channels become
protected, preserving their current "non-members cannot see contents"
behaviour.

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

Migration backfills every existing project to `public`. Before this change there
was no visibility control, and every live project was effectively public because
its name, description and members were readable by any organisation member
through `/api/projects/directory`.

`ProjectRecordSchema` gains `visibility` and `viewerIsMember`.

## Route changes

| Route | Before | After |
|---|---|---|
| `GET /api/users` | Full `UserRecord` only when `roles.includes('owner')`; admins get narrowed `toMemberDirectoryView` | Full `UserRecord` for `isAdminActor` (owner or admin); narrowed directory view for everyone else |
| `GET /api/agents` | `isOwner` decides how much of the list to return | `isAdminActor` decides; admins see the same list owners do |
| `POST /api/agents/:agentId/bindings` | `requireOwner` + `getChannelIfMember` | `requireAdminActor` + `canManageChannelAgents` (admin need not be a member) |
| `DELETE /api/agents/:agentId/bindings/:channelId` | `requireOwner` + `getChannelIfMember` | `requireAdminActor` + `canManageChannelAgents` |
| `GET /api/channels` | Public **or** member channels | Public channels, plus protected channels the viewer is a member of; protected non-member channels excluded even for admins |
| `GET /api/channels/:channelId` *(new)* | Not present | Direct read. Member or admin → full `ChannelRecord`. Non-member org member on protected → limited `ChannelDirectoryEntry`. Non-member on public → full record with `viewerIsMember: false` |
| `POST /api/channels/:channelId/join` | Public channels only | Public channels only; protected channels refuse with `CHANNEL_JOIN_FORBIDDEN` |
| `POST /api/channels/:channelId/members` | `canModifyChannel` (member, or admin on public) | `canModifyChannel` extended to allow admins on protected channels they can see |
| `PATCH /api/channels/:channelId` | Label/topic/description only | Also accepts `visibility` (`public`/`protected`) |
| `GET /api/projects` | Projects the caller is a member of, plus all projects for owner/admin | Public projects are now listed for every org member; protected projects listed only for members and admins |
| `GET /api/projects/directory` | Every live project, limited for non-members/full for members and admins | Excludes protected projects for non-members (admins still see all); public projects remain limited for non-members |
| `GET /api/projects/:projectId` | Member or admin only; 404 for everyone else | Public project → full record for any org member; protected project → limited `ProjectDirectoryEntry` for non-members; full record for members/admins |
| `GET /api/projects/:projectId/members` | Member or admin only | Included in the limited overview for non-members; unchanged authority for the standalone route |
| `PATCH /api/projects/:projectId` | `requireProjectModifier` | Also accepts `visibility` (`public`/`protected`) |
| `POST /api/projects` | `name` + `teamId` | Also accepts `visibility` (`public`/`protected`), defaulting to `public` |
| `GET /api/search` *(new)* | Not present | Global search endpoint returning channels and projects. Protected results include `access: 'limited'` and `locked: true`; public results include `access: 'full'` or the appropriate browse shape. Messages, people, tasks and knowledge continue to use their existing search paths. |
| `DELETE /api/agents/:agentId` *(new)* | Not present | Soft-delete the agent for callers who may edit it. See agent delete contract below. |

`canModifyChannel` (`packages/team-admin/src/resource-authority.ts`) changes
from:

```ts
return isOrganizationAdmin && channel.visibility === 'public' ? { channel } : null
```

to:

```ts
return isOrganizationAdmin ? { channel } : null
```

An admin may manage any channel they can already see (public or protected). The
"can see" check is still enforced by the read path: protected channels do not
appear in the browse list, but an admin who reaches one by direct URL, search, or
admin tooling may manage it.

`canManageChannelAgents` (`packages/team-admin/src/channel-agent-authority.ts`)
changes from:

- organisation **owner** + channel member

to:

- organisation **owner or admin** + able to see the channel (member, or admin on
  any non-system channel). Membership is no longer required.

This is the only change that fixes the "Add" control for agents.

## Admin surface changes

### Create forms

- `admin/src/components/shared/CreateProjectDialog.tsx` adds a **Visibility**
  field with options `Public` / `Protected`, default `Public`.
- `admin/src/components/shared/CreateChannelDialog.tsx` removes the `private`
  option and keeps only `public` / `protected`.

### Lock affordance

- Protected projects and channels render a lock marker in search results,
  directory rows, and the simplified overview.
- The project directory row and channel list row for a protected non-member item
  show the lock and the member list, not counts or content previews.

### Simplified overview

- Opening a protected project as a non-member lands on a read-only overview:
  name, description, visibility, member list, lock marker. No tabs, no boards, no
  channels, no settings actions.
- Opening a protected channel as a non-member lands on the same kind of overview:
  name, member list, lock marker. No message feed, no composer, no tabs.
- An admin who is not a member sees the **full management view** (settings gear,
  members popup, channel info) but still no composer. The server returns the full
  record; message/thread routes remain gated by membership.

### Composer suppression

- `admin/src/components/features/channels/channel-room-controls.ts` and
  `admin/src/pages/channels/ChannelConversationSurface.tsx` suppress the composer
  when the viewer is not a channel member.
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
  { isAdmin })`, matching the new server-side authority.

## Agent delete contract

### Authority

`DELETE /api/agents/:agentId` is allowed for exactly the same callers who may
edit the agent (`packages/runtime/src/agent-edit-authority.ts`):

- A **private** agent: only its live owner.
- A **person-owned shared** agent: its live owner or an organisation owner.
- A **team-owned** agent (`ownerUserId` null): any organisation member who can
  see it through a channel they can read, plus organisation owners.
- **System-managed** agents: refused with `SYSTEM_AGENT_IMMUTABLE`.

The UI shows the delete action on `Admin → Agents` only when `canEditAgent` is
true.

### Hard vs soft delete

Use a **soft delete**. Add `Agent.deletedAt DateTime?`. Agents carry audit
history (runs, messages, approvals) that must not disappear when the
configuration is removed.

- `buildVisibleAgentWhere` (`packages/runtime/src/agent-access.ts`) and every
  agent list/detail read filters `deletedAt: null`.
- The route returns `204` on success.
- Emit audit `agent.deleted` and broadcast `agent.updated` / `agent.deleted` over
  realtime so the agents list removes the row without a refresh.

### Cascading effects

Because the agent row is kept (soft delete), foreign keys do not fire. The route
must explicitly clean up configuration that should die with the agent:

1. **Bindings** — delete every `AgentBinding` row for this agent. The rooms stay;
  the agent simply stops being present.
2. **Triggers** — delete every `AgentTrigger` row for this agent. Existing runs
  keep their `triggerId`; future triggers do not fire. (Alternatively, pause
  triggers; deletion is preferred because a deleted agent can never fire again.)
3. **Auto-created "<name> — Documents" knowledge space** — the space was
  provisioned with `ownerAgentId`. Set `ownerAgentId` to `null` so the
  `ON DELETE NO ACTION` FK is not violated. The space and its pages remain under
  the project; a later cleanup job can remove empty ones. Cloned agents have
  their own separate spaces and are unaffected.
4. **Runs and messages** — left intact. `Run.agentId` stays populated because the
  agent row still exists; history remains attributable.
5. **Child agents** (`parentAgentId`) — left pointing at the deleted parent, or
  optionally set to `null`. Recommendation: leave the pointer for audit, because
  soft delete preserves the row.
6. **Core documents** (`AgentCoreDocument`, `AgentCoreDocumentMigration`) — left
  intact; they are part of the audit trail.

If the product later decides on **hard delete**, the order must be:

1. Set `KnowledgeSpace.ownerAgentId = null` for spaces owned by this agent.
2. Delete `AgentBinding`, `AgentTrigger`, and other config rows.
3. Delete the `Agent` row.

A hard delete cascades to `Run` (which cascades to tool calls, checkpoints,
etc.) and to `Task` (`AgentRunTasks`). That erases operational history, which is
why this specification recommends soft delete.

## Test plan

### Unit / service tests

- `packages/team-admin/test/access-checks.test.ts` (or a new focused test):
  - `canModifyChannel` returns the channel for an admin who is not a member of a
    protected channel.
  - `canModifyChannel` still returns `null` for an ordinary member outside a
    protected channel.
  - `canManageChannelAgents` returns true for an admin who is not a member.
  - `canManageChannelAgents` returns false for an admin on a system channel.
  - `isProjectAccessibleToUser` returns true for an admin on a protected project.
- `packages/team-admin/test/channel-agent-authority.test.ts`: update existing
  cases to cover owner and admin.
- `packages/team-admin/test/agent-list.test.ts` or a new test: verify
  `buildVisibleAgentWhere` excludes soft-deleted agents.

### API tests

- `api/test/channels.test.ts` (or a new route test):
  - Admin can bind/unbind an agent in a protected channel without being a member.
  - Non-member ordinary user cannot join a protected channel.
  - Non-member ordinary user gets `access: 'limited'` from
    `GET /api/channels/:channelId` for a protected channel.
  - Admin gets full `ChannelRecord` from `GET /api/channels/:channelId` for a
    protected channel, with `viewerIsMember: false`.
  - `GET /api/channels` does not return protected non-member channels.
- `api/test/projects.test.ts` (or a new route test):
  - `GET /api/projects` returns public projects for non-member org members.
  - `GET /api/projects/directory` excludes protected projects for non-members.
  - `GET /api/projects/:projectId` returns limited shape for a protected project
    non-member.
  - Admin can patch a protected project's visibility and members without being a
    member.
- `api/test/agent-*.test.ts`:
  - `DELETE /api/agents/:agentId` refuses unauthorised callers.
  - Soft delete removes the agent from listings, deletes bindings, deletes
    triggers, and detaches the auto-created knowledge space owner.
  - System-managed agent delete returns `SYSTEM_AGENT_IMMUTABLE`.
- `api/test/users.test.ts`:
  - Admin receives the full `UserRecord`, including un-narrowed `channelIds`.
  - Ordinary member still receives the directory view.

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
   - Update `Channel.visibility` rows where `private` → `protected`.
   - Alter the `ChannelVisibility` enum to contain only `public` and `protected`.
   - Add `Agent.deletedAt DateTime?`.

2. **Code deploy order**
   - Deploy the API first. The new enum value `protected` must exist before any
     code writes it, and the `Agent.deletedAt` column must exist before the delete
     route is called.
   - Deploy the admin after the API supports the new fields and routes.

3. **Behaviour for existing data**
   - Existing **public** channels remain public and visible to all organisation
     members.
   - Existing **private** channels become protected, so non-members still cannot
     see their contents.
   - Existing **projects** become public, preserving today's "name, description
     and members are visible to any org member" behaviour.
   - No existing member loses access to anything they could already open.
   - No existing admin gains the ability to read message history of a protected
     room they are not in; they gain only management metadata.

4. **Search**
   - The new `GET /api/search` endpoint must be deployed and backfilled with the
     same visibility rules before the client can rely on search for protected
     discovery. Until then, protected projects and channels are discoverable only
     by direct URL.

## Open questions

1. **What exactly does an admin non-member see when they open a protected
   project or channel?**
   The decisions say a non-member sees a simplified overview (name + members),
   but decision 1 also says an admin has owner-level management reach. This
   specification recommends returning the **full management record** to admins
   (settings, member list, rename/archive controls) while still suppressing the
   composer and blocking message/thread reads. That preserves "management is not
   participation" and gives admins the controls they need. If the product prefers
   admins to see the same simplified overview as ordinary non-members, the admin
   would have to open a separate management surface to add members or change
   visibility.

2. **May an admin add themselves to a protected project or channel?**
   Decision 3 says joining is not self-service. Decision 1 says an admin may add
   and remove people. This specification recommends **yes**: an admin may add
   themselves through the explicit members management action, because owner-level
   reach would otherwise be hollow for protected rooms. The trade-off is that
   this looks like self-service for admins; the UI should make clear that the
   action is management, not joining.

3. **Should the global search endpoint own all result kinds, or only
   channels/projects?**
   Today global search is client-side, filtering already-loaded channels,
   projects, people, etc. Making protected rooms discoverable requires a server
   source. This specification adds `GET /api/search` for channels and projects
   only, leaving messages/tasks/knowledge on their existing endpoints. An
   alternative is a single unified search endpoint; the trade-off is scope and
   cache invalidation complexity.

4. **Agent delete: hard or soft?**
   This specification chooses **soft delete** to preserve runs and messages. If
   the product wants a hard delete, the implementation must first detach
   `KnowledgeSpace.ownerAgentId`, accept that cascading FKs will delete runs and
   trigger history, and decide what to do with child agents. A hard delete is
   irreversible and loses operational audit data.

5. **What happens to active runs when an agent is soft-deleted?**
   The agent row still exists, so in-flight runs could continue. This
   specification recommends cancelling queued and running agent runs as part of
   the delete transaction, or at minimum refusing to start new runs for a
   soft-deleted agent. Otherwise a deleted agent could keep answering.

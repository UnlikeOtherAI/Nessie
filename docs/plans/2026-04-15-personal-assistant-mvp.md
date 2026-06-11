# Personal Assistant MVP

> Status: replacement brief after the audience-scoped memory reset.

## 1. Product Rules

The core model is simple:

- the personal assistant is the user's delegated second self
- every user gets exactly one direct `Personal Assistant` relationship and DM
  per organization
- it always appears at the top of that user's DMs
- it uses the same runtime stack as a regular agent
- it has exactly the same permissions as the user who is talking to it
- it has a user-scoped memory built from that user's conversations across the
  workspace

The assistant must be able to do anything the user can do in the product.

Sometimes that means the assistant acts directly, for example by searching
messages, sending a reply, sharing a document, or updating user settings.
Sometimes that means the assistant delegates a specialist agent, because that is
already how the product exposes that capability to the user.

The contract stays the same in both cases:

- same authority as the user
- same visibility as the user
- same write reach as the user
- no independent power beyond what the user could already do

For MVP, day-one delivery can still sequence lower-frequency actions later.
That is an implementation-coverage choice, not a different permission model.

That means we need to separate:

- the assistant surface
- the assistant's own memory
- the wider workspace context the assistant can read live

Those are not the same thing.

## 2. Core Decision

We should stop treating `Personal Assistant` as a separate product stack.

For the MVP, it should be:

- one system-managed regular `Agent` per organization
- one private DM `Channel` per user
- one normal `Thread` inside that DM
- one normal run/orchestrator/tool path

We should **not** build the earlier template + per-user cloned-agent model for
the MVP.

That was trying to solve privacy with new object types. We now have a better
foundation: audience-scoped memory and scoped runtime access. The simpler model
is:

- one shared agent definition
- private per-user conversation surface
- private per-user assistant memory built from the user's conversations
- delegated workspace access using the current user's permissions
- the same user-visible action surface the user already has

## 3. Why This Stays Compatible With Regular Agents

The personal assistant should be implemented as a regular agent with a few
special policies, not a custom runtime.

Shared pieces:

- same `Agent` config model
- same `Channel` / `Thread` / `Message` records
- same `Run` execution path
- same tool system
- same routing/model configuration
- same policy and audit systems
- same memory infrastructure

Special policies:

- guaranteed DM surface for every user
- exactly the same authorization scope as the requesting user
- user-scoped assistant memory
- delegated read/write access using the requesting user's permissions
- DM-anchored control surface, even when the assistant acts elsewhere for the
  user
- user-equivalent action scope: if the user can do it, the assistant can do it;
  if the user would need to delegate another agent, the assistant does that too

> **Update (2026-06-11) — privileged delegate, org-wide reach.** The personal
> assistant is treated as its owner's privileged delegate and reaches **every
> channel in the organization** — not only public channels plus the ones the
> owner has joined. It is exempt from the `AgentBinding` "is this bot a member of
> the channel?" gate (both when scheduling a task and when the scheduled task
> fires), because binding does not apply to a delegate that acts as the user.
> Channel resolution (post/schedule/list), workspace + message search, and
> curated-thought recall (`resolveAccessibleScopes` `personal_assistant` mode)
> all resolve org-wide for the PA. This deliberately broadens the original
> "same scope as the user" framing above; the gate is `agentKind =
> personal_assistant`, so ordinary (`shared`) agents are unaffected.

This keeps the MVP small and gives us a clean path to future managed assistants.

## 4. MVP Behavior

### User experience

- Every user sees `Personal Assistant` pinned at the top of DMs.
- Opening it finds or creates that user's private DM.
- The assistant behaves like a normal chat assistant inside that DM.
- The assistant can see whatever the user can already see.
- The assistant can search across conversations, projects, channels, groups,
  meetings, and other workspace surfaces anywhere the user has access.
- The assistant can search the user's past authored messages across the
  workspace and use them to ground replies and actions.
- The assistant remains anchored to the user's DM as its control surface, even
  when acting elsewhere on the user's behalf.

### Admin experience

For the MVP, admins should configure it through the normal agent editing path,
because it is still a normal agent record.

What is different:

- the agent kind is fixed to `personal_assistant`
- the name is fixed to `Personal Assistant`
- the surface policy is fixed to `dm_only`
- the system guarantees one exists per org

Those fixed fields must be backend invariants, not just UI defaults.

Admins should not be able to delete the system-managed PA from the normal agent
editing flow.

Admins can still change the normal agent configuration:

- system prompt
- model / routing
- tools and policies that shape how the assistant speaks, plans, searches, and
  delegates on the user's behalf
- attached markdown docs

Because the assistant runs with user permissions but can be configured by org
admins, the trust boundary must be explicit:

- admin configuration can shape behavior, but it cannot bypass user-scoped
  permission, memory, or surface-policy enforcement
- admin changes to prompt, docs, and tool policy should be auditable
- users should be able to inspect the current admin-managed configuration
  summary from the PA DM so this never acts like a hidden deputy

Normal agent surfaces that must stay blocked for PA:

- clone
- triggers / workflows / automation
- generic agent activity panels that aggregate by `agentId` alone
- any admin surface that would expose cross-user PA runs or messages

## 5. Minimal Data Model

The MVP should avoid new personal-assistant-specific tables unless we discover a
hard blocker.

### `Agent`

Use the existing `Agent` model and add the minimum policy fields needed to make
this one special:

- `agentKind = shared | personal_assistant`
- `systemManaged = boolean`
- `surfacePolicy = shared | dm_only`
- `delegationMode = none | act_as_requesting_user`

For the built-in assistant:

- `agentKind = personal_assistant`
- `systemManaged = true`
- `surfacePolicy = dm_only`
- `delegationMode = act_as_requesting_user`

Required invariant rules:

- exactly one `personal_assistant` agent per organization
- bootstrap recreates it if it is missing
- once `systemManaged = true`, `agentKind`, `name`, `surfacePolicy`, and
  `delegationMode` are immutable outside system bootstrap/migration code paths
- normal admin delete/archive flows must block hard deletion of the
  `systemManaged` PA agent

### `Channel`

Use a normal DM channel with a deterministic key:

```text
pa:{organizationId}:{userId}
```

That gives us:

- one personal-assistant DM per user per org
- idempotent bootstrap
- no need for a separate instance table in the MVP
- compatibility with existing DM/thread/message models

Because `Channel.teamId` is currently required, PA DMs should live in a hidden
system team per organization unless the schema is intentionally changed later.
That team should exist only to satisfy channel topology and should not expose PA
DMs through normal team browsing or governance surfaces.

The channel should also carry an explicit marker in metadata, for example:

```json
{
  "systemChannelType": "personal_assistant",
  "ownerUserId": "..."
}
```

Lifecycle rule:

- if the user leaves the org, archive the PA DM and apply the same retention
  policy to its thread history and user-scoped PA memory
- if the user later regains access with the same identity, bootstrap can reopen
  or recreate from the retained state according to that retention policy

### `AgentBinding`

Bind the personal assistant agent to that channel through a system-only
bootstrap bind path.

Rules:

- generic `bindAgentToChannel()` must reject `surfacePolicy = dm_only`
- bootstrap is the only allowed code path that may create the PA DM binding
- generic bind UI and bind APIs never expose `personal_assistant`

### PA UI data isolation

The PA must not reuse generic agent activity/message surfaces that aggregate by
`agentId` alone.

Frontend and API rules:

- PA conversation UI should read from the user's PA DM channel/thread as the
  primary source of truth
- if the product still needs PA-specific activity drill-down, those queries must
  be additionally scoped by `effectiveUserId` and `triggerChannelId`
- generic `useAgentActivity(agentId)` / `useAgentMessages(agentId)` style flows
  must not be pointed at the built-in PA without that extra scoping
- PA websocket/event delivery must be scoped to the PA DM participants and
  authorized admin/audit surfaces, never to generic org-wide agent feeds keyed
  only by `agentId`

### `Message` / audit metadata

When the assistant posts on behalf of the user, keep provenance:

- `senderUserId = userId`
- metadata includes `delegatedByAgentId`
- metadata includes `delegatedFromRunId`

The message should read as sent by the user, but the audit trail must still show
that the personal assistant executed it.

If the product later wants participant-visible provenance, it can render a
lightweight "via Personal Assistant" affordance from that metadata without
changing the underlying author model.

MVP policy should be explicit:

- delegated messages are intentionally attributed to the user, like a delegated
  executive-assistant action
- provenance remains available in audit and can be surfaced to the sender,
  admins, or later recipient-facing UI if product decides that trust tradeoff is
  worth exposing

> **Update (2026-06-11) — scheduled posts are delegated too.** This author model
> now applies to **scheduled** PA posts as well, not just immediate sends. When a
> PA-owned scheduled task fires into a shared channel, the run's final message is
> authored as the owner (`userId = owner`, `role = user`, `metadata`
> `delegatedByAgentId` + `delegatedFromRunId`) instead of as the assistant bot.
> The task's internal kickoff/instruction message is written with `role = system`
> so it drives the run but is excluded from both the channel feed
> (`listThreadMessages`) and model context (`loadConversation`); shared agents
> keep their visible `role = user` kickoff. PA replies **inside the PA DM** stay
> assistant-authored.

### `Agent` execution policy

For the MVP, the personal assistant should follow the same action model the
user already has in the product.

That means:

- if the user can search, read, post, share, organize, or change a personal
  setting, the assistant can do that too
- if the user can only achieve a task by delegating another agent, the personal
  assistant should use that same delegation path instead of bypassing it
- the personal assistant should not gain a separate low-level power surface just
  because it is implemented as an agent

Primary action families:

- workspace-wide search / read across visible conversations, projects,
  channels, groups, meetings, and related objects
- authored-message search across the user's history
- user / people search and lookup across visible workspace entities
- message send / reply / thread creation / follow-up
- document share / attach into conversations
- delegation to other agents
- user preference and personal settings updates

The important boundary is not "communication versus tools." The important
boundary is "same user authority, no extra authority."

## 6. Memory Model

This is the most important rule in the whole design:

- the assistant's memory is **user-scoped**, not DM-scoped
- the assistant's memory is still **not** the same thing as generic workspace
  search

The governing asymmetry should be explicit:

- the assistant can search everything the user can see
- the assistant can persist only user-scoped memory derived from the user's own
  authored history and approved summaries about the user's commitments,
  agreements, plans, and working relationships

### What becomes personal-assistant memory

The assistant should accumulate a persistent memory of the user's own
communication history across the workspace.

For MVP, that means two sources:

- direct DM conversation with `Personal Assistant`
- memories distilled from messages the user has authored in other DMs, channels,
  meetings, groups, and threads they can access

This should let the assistant know:

- what the user has said before
- what the user prefers
- what the user committed to
- what the user agreed to in prior conversations
- what patterns exist in how the user communicates with different teams

For example, the assistant should be able to remember:

- "I already told the design team we are shipping Friday"
- "I usually ask Alice to own rollout comms"
- "In the platform thread I agreed to split the migration between Bob and Eve"

### What should be captured from workspace conversations

For MVP, the safest useful capture rule is:

- capture from messages authored by the user anywhere they can speak
- allow derived user-scoped summaries from conversations the user participated
  in when those summaries are about the user's commitments, agreements, plans,
  or working relationships and are tightly anchored to the user's own authored
  messages or directly attributed commitments

Examples:

- allowed: "I agreed to own rollout comms by Friday"
- allowed: "In the migration thread I asked Bob to take the API piece"
- not allowed: "The team debated three rollout options"
- not allowed: "Alice and Eve disagreed about architecture"

That gives us "my assistant knows what I have said and agreed to" without
turning it into a raw global transcript mirror of every shared conversation.

The assistant should also have a live search tool over the user's past authored
messages, so even when a detail is not promoted into persistent memory, it can
still reconstruct what the user previously said.

### Retrieval architecture

The brief should distinguish persistent memory from live search:

- persistent memory is for durable user facts, commitments, preferences,
  working relationships, and prior decisions already distilled into
  user-scoped memory
- live authored-message search is for exact wording, narrow factual lookup, and
  details that were not promoted into persistent memory
- live workspace search is for current shared context the user can access, even
  when that content must never become persistent PA memory

Expected retrieval order:

1. load user-scoped persistent memory
2. issue live authored-message search when the answer needs exact prior wording
   or unpromoted user history
3. issue live workspace search when the answer depends on current channel,
   project, meeting, or participant context

The assistant should not treat these as interchangeable stores.

For MVP, `user_conversation_summary` should also use a shorter retention window
than direct authored-message memories unless later implementation work proves
that longer retention is safe and useful.

### What should stay out of assistant memory by default

Do **not** automatically store all shared conversation content from other people
as personal-assistant memory.

In particular, do not persist as user memory by default:

- every raw message from teammates
- arbitrary channel history the user merely read
- whole documents or files the assistant opened
- unrelated project chatter that is not tied to the user's own commitments or
  relationship to the work

Those should stay available through live search tools, not become permanent
user-scoped assistant memory automatically.

### Storage rule

These memories should still be stored as user-scoped memories:

- `organization_id = orgId`
- `audience_type = user`
- `audience_id = userId`

And they should carry a source marker so we can distinguish kinds of user memory:

- `memory_origin = personal_assistant_dm`
- `memory_origin = user_authored_workspace_message`
- `memory_origin = user_conversation_summary`
- `source_audience = dm | channel | group | meeting | project | ...`

`memory_origin` can stay in metadata for MVP if we do not want a first-class
column yet, but the implementation should either index it directly or promote it
to a first-class column before scale makes metadata filtering unsafe.

### Retrieval rule

When the personal assistant recalls persistent memory, filter by:

- `organization_id = orgId`
- `audience = user:{userId}`
- `memory_origin in personal-assistant user-memory origins`

That ensures:

- one user's assistant never sees another user's assistant memory
- the assistant can build continuity from the user's history across all their
  conversations
- future user-scoped assistants do not automatically share memory unless we
  explicitly choose that later

For outbound writes, source context still matters:

- narrower-source memories may inform the assistant's reasoning in the PA DM
- the assistant should not project a narrower-source memory into a broader
  outbound write unless the target surface is source-compatible or the user
  explicitly confirms sharing that context now

### Memory correction and forgetting

The doc should make source-of-truth behavior explicit:

- if a user asks the assistant to forget something, delete or tombstone the
  user-scoped PA memory entry without changing the source workspace message
- if a source user-authored message is deleted or materially edited, linked
  `user_authored_workspace_message` memories should be invalidated or
  re-derived
- forgetting should also create a suppression record tied to the source refs so
  the same fact is not silently re-captured from unchanged source material
- if retention removes archived PA memory, bootstrap should not silently
  reconstruct deleted memories unless the source-capture rules fire again from
  still-existing workspace history

## 7. Workspace Access Model

The assistant should be able to act across the workspace with the same
permissions as the user talking to it.

That means the run needs two identities:

- **agent identity**: the personal assistant agent configuration
- **effective user identity**: the user whose DM triggered the run

The effective user identity should be exact, not approximate.

That means:

- no extra permissions beyond the user
- no reduced permissions compared with the user
- all authorization checks should resolve exactly as if the user performed the
  action directly

This must be a runtime invariant, not a convention.

Every assistant run should carry:

- `effectiveUserId`
- `triggerChannelId`
- `triggerThreadId`
- `delegationDepth`

And every internal read, write, search, memory operation, prompt/context
assembly step, and tool call must validate against that run context.

### Read access and workspace search

All read/search tools used by the personal assistant should evaluate access
using the effective user identity.

Examples:

- search across conversations, channels, projects, groups, meetings, and other
  collaboration surfaces the user can access
- search messages in channels the user can access
- search project history, channel history, meeting context, and related
  workspace records wherever the user already has access
- search all past messages authored by the user
- find a specific user by name, role, team, project, or prior collaboration
  context where the user could already discover that person
- read threads the user can open
- list groups, projects, teams, and channels visible to the user
- inspect visible user, member, and participant records needed to route work or
  send a message to the right person
- inspect the user's own sent messages and surrounding thread context
- inspect team conversations and documents the user can currently access in
  order to ground a response or a delegated action
- inspect meetings, calls, and other collaboration surfaces if the user can
  already inspect them

The rule is simple:

- if the user can see it, the assistant can see it
- if the user cannot see it, the assistant cannot see it

That same rule must apply to:

- direct assistant reads that do not go through delegated tools
- context assembly before model invocation
- memory retrieval joins
- any indexing or search helper that fetches workspace records on the
  assistant's behalf

### User-equivalent action scope

The personal assistant should expose the same action surface the user has, not a
smaller one.

In practice that means:

- the assistant can read, search, draft, send, organize, share, and follow up
  anywhere the user can
- the assistant can search workspace history and objects anywhere the user has
  access, not just the user's own past messages
- the assistant can look up the right person to contact based on visible
  workspace identity data plus the user's own history
- the assistant can coordinate people and split work based on the user's memory
  plus live workspace context
- the assistant can change the user's own preferences and settings where the
  user could do so directly
- the assistant can delegate specialist work to other agents wherever the user
  would do the same thing

The important nuance is execution shape:

- the assistant is not meant to become a specialist engineer, researcher, or
  operator in its own DM
- when the product requires agent delegation for real specialist work, the
  personal assistant should perform that same delegation for the user

That delegation must inherit the same effective user permissions as the
requesting user.

Delegation rules:

- delegated agents receive the same `effectiveUserId`
- the originating PA run remains the root provenance context
- permission checks are re-evaluated immediately before every delegated write
- delegation depth must be bounded and cycles must be rejected
- `effectiveUserId` must be bound to run context and validated at authorization
  time, not passed as an untrusted mutable parameter in prompts or tool payloads

### Write access

For the MVP, delegated write should cover the normal collaboration actions users
actually need:

- send message
- reply in thread
- create thread where the user could create one
- attach or reference a document the user selected for sending
- compose and send coordination messages that assign or split work based on live
  context plus the user's assistant memory, and invoke existing assignment flows
  the user already has where those product features exist
- delegate work to other agents based on the user's request
- follow up, remind, and summarize into conversations the user can post in

If there are user actions we do not ship on day one, that should be treated as
implementation sequencing, not as a different permission model.

The target rule stays:

- if the user can perform the action directly, the assistant should eventually
  be able to perform it too
- if the user can only perform it by delegating another agent, the assistant
  should be able to trigger that same delegation path

### Safety rule

The personal assistant should not act autonomously in shared spaces. Every write
must come from an explicit request in the DM from that same user.

The assistant can draft, plan, and propose freely, but posting should still be a
direct delegated action from the current DM session.

High-impact actions may still use a preview or confirmation step in the DM
without changing the underlying authority model. That is a UX safety pattern,
not a different permission scope.

For MVP, "explicit request" should mean:

- the request comes from the user's PA DM
- the current request explicitly names or confirms the target surface and the
  intent of the write; prior context alone is not enough
- any follow-up or reminder write happens synchronously as part of that current
  DM request, not as an autonomous scheduled action later

This is enough to support flows like:

- "Take this document and send it to the team"
- "Split the work between the people who usually own these parts"
- "Follow up based on what we already agreed in the migration thread"
- "Delegate implementation to the right agent, but do not do the work yourself"
- "I cannot run tools directly, so delegate the right agent to do it for me"

## 8. Visibility And Presence Model

The personal assistant should not have a separate visibility model from the
user.

The rule should be:

- it can inspect any surface the user can inspect
- it can post anywhere the user can post
- it cannot inspect or post anywhere the user cannot inspect or post

This should be enforced as "same permissions as the user," not as a special
secondary access model.

What stays special is not visibility. What stays special is presence.

For MVP:

- its home surface is still the private DM with the user
- it should not appear as a separate inviteable participant in generic agent
  pickers
- it should act as the user's delegate, not as an independently added teammate
- users can mute PA notifications, but cannot delete the system assistant or
  remove its access point from the DM surface

So the system should hide it from generic "add agent" flows, but not block it
from reading or writing in surfaces the user can already access, including
meetings, groups, channels, threads, and other collaboration surfaces the user
can already inspect or post in.

## 9. Bootstrap Flow

We still want a dedicated bootstrap endpoint because the surface is guaranteed.

### Suggested flow

1. User opens `Personal Assistant` from the DM list.
2. Client calls `POST /api/personal-assistant/bootstrap`.
3. API ensures the org-level `Personal Assistant` agent exists.
4. API finds or creates the DM channel with `dmKey = pa:{org}:{user}`.
5. API ensures the channel has a default thread.
6. API creates or verifies the PA binding through the system-only bootstrap bind
   path.
7. API marks the DM as pinned in the returned payload or through a server-side
   pinned-DM rule.
8. API returns the normal channel/thread payload for navigation plus a visible
   summary of the current admin-managed PA configuration.

The endpoint must be idempotent.
It also needs DB-level uniqueness or transactional locking so concurrent
bootstrap calls cannot create duplicate PA channels or bindings.

### Suggested response

```json
{
  "agent": { "id": "...", "name": "Personal Assistant" },
  "channel": { "id": "...", "type": "dm" },
  "thread": { "id": "...", "title": "General" }
}
```

## 10. Required Enforcement Points

The MVP needs real backend enforcement in a few places:

- exactly-one-personal-assistant-per-org must be a real invariant
- fixed PA fields must be immutable outside system-managed code paths
- admin-managed prompt, docs, and tool policy must remain auditable and cannot
  override permission, memory, or surface-policy boundaries
- users must be able to inspect the current admin-managed PA configuration from
  the PA surface
- generic `bindAgentToChannel()` must reject `surfacePolicy = dm_only`
- bootstrap must use a separate system-only bind path for the PA DM
- agent discovery/listing must hide personal assistants from normal lists
- generic clone, trigger, workflow, and admin automation surfaces must reject
  `personal_assistant`
- PA UI reads must not use generic agent-activity/message aggregation keyed only
  by `agentId`
- PA realtime events, run updates, and admin snapshots must never fan out
  through generic org-wide agent feeds keyed only by `agentId`
- all assistant reads, writes, searches, memory retrievals, and context assembly
  must run with effective user permissions
- delegated tools must run with effective user permissions
- delegated agents spawned by the personal assistant must inherit the same
  effective user permissions plus bounded depth and cycle protection
- memory capture/retrieval must apply the `user + personal-assistant user memory`
  filter plus org scoping
- message-memory capture must include the user's authored messages across the
  workspace
- derived memory capture must stay user-scoped even when sourced from shared
  conversations
- outbound writes must respect source-audience compatibility unless the user
  explicitly confirms broader sharing
- source message edit/delete events must invalidate or re-derive linked PA
  memories
- forgotten memories must have suppression so they are not silently re-captured
- the execution layer must preserve the "same user authority, same user
  delegation paths" rule instead of giving the assistant a weaker or broader
  action model
- delegated posts must retain provenance metadata and be able to surface user-
  visible provenance if product chooses to expose it

This is still mostly normal-agent infrastructure, but it does require shared
permission and execution plumbing rather than a few isolated UI checks.

## 11. What We Are Deliberately Not Doing In MVP

Do not add these yet:

- per-user cloned agent instances
- separate personal assistant template/instance tables
- auto-capture of full shared conversation history from other participants into
  PA memory
- admin-created arbitrary managed assistants
- full coverage of lower-frequency destructive user actions on day one
- a special low-level tool bypass that skips the same delegation path users
  already rely on

Those can come later if the MVP works.

## 12. Future-Compatible Direction

If we later want more managed assistants, this MVP still scales cleanly.

The general model becomes:

- regular agent definition
- installation policy
- surface policy
- delegation policy
- memory origin policy

Under that model:

- `Personal Assistant` is the built-in user-scoped installation
- future "Documentation Assistant" or "Knowledge Assistant" can reuse the same
  machinery
- the new audience-scoped memory rules remain the hard security boundary

## 13. Recommended Build Order

1. Inventory existing search, tool, and delegation paths that must accept
   `effectiveUserId`, and retrofit the shared execution layer before building on
   top of it.
2. Add the personal-assistant agent invariants, uniqueness rules, and system-
   only bootstrap bind path.
3. Add hidden system-team placement for PA DMs plus DM bootstrap and pinned-DM
   behavior.
4. Add effective-user enforcement across direct reads/search, context assembly,
   tool dispatch, delegated agents, and pre-write rechecks.
5. Add PA-specific UI/API isolation so DM history and activity never aggregate
   across users by `agentId` alone.
6. Add workspace search coverage plus authored-message search.
7. Add the personal-assistant user-memory extraction, retrieval, invalidation,
   and forgetting rules.
8. Add provenance/audit metadata for delegated posts.

That is enough for a real MVP.

## 14. Short Version

The MVP should be:

- one system-managed regular agent called `Personal Assistant`
- one private DM per user
- one private user-scoped assistant-memory namespace per user, built from that
  user's conversations across the workspace
- live workspace read/write with exactly the same permissions as the user
- the same user-visible action surface the user already has
- specialist work routed through the same agent-delegation path the user would
  use
- a DM-anchored control surface, not a separate visible teammate

That is much simpler than the previous design, and it is compatible with the
direction we now want for the rest of the agent system.

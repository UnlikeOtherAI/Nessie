# Personal Assistant MVP

> Status: replacement brief after the audience-scoped memory reset.

## 1. Product Rules

The MVP should follow five rules:

- every user gets exactly one `Personal Assistant`
- it always appears at the top of that user's DMs
- it uses the same runtime stack as a regular agent
- it does not get any visibility the user does not already have
- it has a user-scoped memory built from that user's conversations across the
  workspace

At the same time, the assistant must be able to read and write across the
workspace using the same permissions as the user who is talking to it.

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
- restricted toolset focused on communication, delegation, and user settings

This keeps the MVP small and gives us a clean path to future managed assistants.

## 4. MVP Behavior

### User experience

- Every user sees `Personal Assistant` pinned at the top of DMs.
- Opening it finds or creates that user's private DM.
- The assistant behaves like a normal chat assistant inside that DM.
- The assistant can see whatever the user can already see.
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

Admins can still change the normal agent configuration:

- system prompt
- model / routing
- tools, within the restricted personal-assistant toolset
- attached markdown docs

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

### `Channel`

Use a normal DM channel with a deterministic key:

```text
pa:{organizationId}:{userId}
```

That gives us:

- one personal-assistant DM per user per org
- idempotent bootstrap
- no need for a separate instance table in the MVP

The channel should also carry an explicit marker in metadata, for example:

```json
{
  "systemChannelType": "personal_assistant",
  "ownerUserId": "..."
}
```

### `AgentBinding`

Bind the personal assistant agent to that channel using the normal binding path,
but never expose this through generic bind UI.

### `Message` / audit metadata

When the assistant posts on behalf of the user, keep provenance:

- `senderUserId = userId`
- metadata includes `delegatedByAgentId`
- metadata includes `delegatedFromRunId`

The message should read as sent by the user, but the audit trail must still show
that the personal assistant executed it.

### `Agent` tool policy

For the MVP, the personal assistant should not have the normal broad agent tool
surface.

Allowed tool families:

- message search / read
- message send / reply / thread creation
- document share / attach into conversations
- delegation to other agents
- user preference and personal settings updates

Not allowed:

- bash
- file write
- code execution
- generic research or admin tool surfaces
- doing specialist work itself instead of delegating it to another agent

## 6. Memory Model

This is the most important rule in the whole design:

- the assistant's memory is **user-scoped**, not DM-scoped
- the assistant's memory is still **not** the same thing as generic workspace
  search

### What becomes personal-assistant memory

The assistant should accumulate a persistent memory of the user's own
communication history across the workspace.

For MVP, that means two sources:

- direct DM conversation with `Personal Assistant`
- memories distilled from messages the user has authored in other DMs, channels,
  and threads

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
  or working relationships

That gives us "my assistant knows what I have said and agreed to" without
turning it into a raw global transcript mirror of every shared conversation.

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

- `audience_type = user`
- `audience_id = userId`

And they should carry a source marker so we can distinguish kinds of user memory:

- `memory_origin = personal_assistant_dm`
- `memory_origin = user_authored_workspace_message`
- `memory_origin = user_conversation_summary`

`memory_origin` can stay in metadata for MVP if we do not want a first-class
column yet.

### Retrieval rule

When the personal assistant recalls persistent memory, filter by:

- `audience = user:{userId}`
- `memory_origin in personal-assistant user-memory origins`

That ensures:

- one user's assistant never sees another user's assistant memory
- the assistant can build continuity from the user's history across all their
  conversations
- future user-scoped assistants do not automatically share memory unless we
  explicitly choose that later

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

### Read access

All read/search tools used by the personal assistant should evaluate access
using the effective user identity.

Examples:

- search messages in channels the user can access
- search all past messages authored by the user
- read threads the user can open
- list groups, projects, teams, and channels visible to the user
- inspect the user's own sent messages and surrounding thread context
- inspect team conversations and documents the user can currently access in
  order to ground a response or a delegated action
- inspect meetings, calls, and other collaboration surfaces if the user can
  already inspect them

The rule is simple:

- if the user can see it, the assistant can see it
- if the user cannot see it, the assistant cannot see it

### Tool scope

Even though the assistant should have the same permissions as the user, it does
not need the same product capability surface as every other agent.

It is a communication and delegation assistant.

That means it should use tools for:

- reading message history
- finding the right people and conversations
- sending messages and threads
- sharing documents into conversations
- updating the user's own assistant/user preferences
- delegating work to other agents

It should not use tools for:

- directly doing engineering or specialist work
- editing files
- running shell commands
- operating arbitrary external systems

For any real work beyond communication and settings, the personal assistant
should delegate a worker agent instead of doing the work itself.

That delegation should inherit the same effective user permissions as the
requesting user.

### Write access

For the MVP, delegated write should cover normal communication actions:

- send message
- reply in thread
- create thread where the user could create one
- attach or reference a document the user selected for sending
- assign or split work in a message based on live context plus the user's
  assistant memory
- delegate work to other agents based on the user's request

This is enough to satisfy "send messages on my behalf" and "delegate work on my
behalf" without taking on the full destructive-moderation surface on day one.

I would keep these out of MVP unless we explicitly choose them:

- delete messages
- bulk edits
- membership changes
- administrative moderation actions

### Safety rule

The personal assistant should not act autonomously in shared spaces. Every write
must come from an explicit request in the DM from that same user.

The assistant can draft, plan, and propose freely, but posting should still be a
direct delegated action from the current DM session.

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

So the system should hide it from generic "add agent" flows, but not block it
from reading or writing in surfaces the user can already access.

## 9. Bootstrap Flow

We still want a dedicated bootstrap endpoint because the surface is guaranteed.

### Suggested flow

1. User opens `Personal Assistant` from the DM list.
2. Client calls `POST /api/personal-assistant/bootstrap`.
3. API ensures the org-level `Personal Assistant` agent exists.
4. API finds or creates the DM channel with `dmKey = pa:{org}:{user}`.
5. API ensures the channel has a default thread.
6. API ensures the personal assistant agent is bound to that DM.
7. API returns the normal channel/thread payload for navigation.

The endpoint must be idempotent.

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

- generic `bindAgentToChannel()` must reject `surfacePolicy = dm_only`
- agent discovery/listing must hide personal assistants from normal lists
- delegated tools must run with effective user permissions
- delegated agents spawned by the personal assistant must inherit the same
  effective user permissions
- memory capture/retrieval must apply the `user + personal-assistant user memory`
  filter
- message-memory capture must include the user's authored messages across the
  workspace
- derived memory capture must stay user-scoped even when sourced from shared
  conversations
- the tool registry must restrict personal assistants to communication,
  delegation, and user-setting tools

If those checks are solid, the rest of the system can stay mostly normal.

## 11. What We Are Deliberately Not Doing In MVP

Do not add these yet:

- per-user cloned agent instances
- separate personal assistant template/instance tables
- auto-promotion of workspace conversations into PA memory
- admin-created arbitrary managed assistants
- broad destructive write delegation
- broad regular-agent tool access

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

1. Add the personal-assistant agent flags and DM bootstrap path.
2. Pin the assistant to the top of the DM list.
3. Enforce `dm_only` surface policy everywhere shared-agent flows exist.
4. Add delegated read/write execution using effective user permissions.
5. Add the `memory_origin = personal_assistant` capture and retrieval rule.
6. Add provenance/audit metadata for delegated posts.

That is enough for a real MVP.

## 14. Short Version

The MVP should be:

- one system-managed regular agent called `Personal Assistant`
- one private DM per user
- one private user-scoped assistant-memory namespace per user, built from that
  user's conversations across the workspace
- live workspace read/write with exactly the same permissions as the user
- restricted tools for communication, delegation, and personal settings
- a DM-anchored control surface, not a separate visible teammate

That is much simpler than the previous design, and it is compatible with the
direction we now want for the rest of the agent system.

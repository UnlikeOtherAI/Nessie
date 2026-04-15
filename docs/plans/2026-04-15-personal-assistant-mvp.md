# Personal Assistant MVP

> Status: replacement brief after the audience-scoped memory reset.

## 1. Product Rules

The MVP should follow five rules:

- every user gets exactly one `Personal Assistant`
- it always appears at the top of that user's DMs
- it uses the same runtime stack as a regular agent
- it cannot be added to channels, meetings, workflows, or any other shared surface
- its own memory comes only from that user's direct conversation with it

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
- private per-user assistant memory
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
- hidden from generic bind/invite surfaces
- user-scoped assistant memory
- delegated read/write access using the requesting user's permissions

This keeps the MVP small and gives us a clean path to future managed assistants.

## 4. MVP Behavior

### User experience

- Every user sees `Personal Assistant` pinned at the top of DMs.
- Opening it finds or creates that user's private DM.
- The assistant behaves like a normal chat assistant inside that DM.
- The user cannot move it into a channel, call, or meeting.

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
- tools
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

## 6. Memory Model

This is the most important rule in the whole design:

- the assistant's own memory is **not** the same thing as the workspace data it
  can read

### What becomes personal-assistant memory

Only information coming from the direct DM between the user and `Personal
Assistant` should become its own persistent memory.

That means:

- user preferences expressed in the DM
- reminders or facts the user tells the assistant directly
- assistant-created summaries or plans created in that DM
- explicit "remember this" captures from that DM

Those memories should be stored with:

- `audience_type = user`
- `audience_id = userId`
- `memory_origin = personal_assistant`

`memory_origin` can live in dedicated metadata for the MVP if we do not want a
new first-class column yet.

### What does **not** become personal-assistant memory automatically

Do **not** automatically persist:

- channel messages the assistant read while answering
- project discussions it inspected
- files or docs it opened from shared spaces
- group chat content it quoted during a response

Those are run-time context sources, not personal-assistant memory.

### Retrieval rule

When the personal assistant recalls its own memory, filter by both:

- `audience = user:{userId}`
- `memory_origin = personal_assistant`

That ensures:

- one user's assistant never sees another user's assistant memory
- future user-scoped assistants do not automatically share the PA's private
  memory unless we explicitly choose that later

## 7. Workspace Access Model

The assistant should be able to act across the workspace with the same
permissions as the user talking to it.

That means the run needs two identities:

- **agent identity**: the personal assistant agent configuration
- **effective user identity**: the user whose DM triggered the run

### Read access

All read/search tools used by the personal assistant should evaluate access
using the effective user identity.

Examples:

- search messages in channels the user can access
- read threads the user can open
- list groups, projects, teams, and channels visible to the user
- inspect the user's own sent messages and surrounding thread context

### Write access

For the MVP, delegated write should cover normal communication actions:

- send message
- reply in thread
- create thread where the user could create one

This is enough to satisfy "send messages on my behalf" without taking on the
full destructive-moderation surface on day one.

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

## 8. Surfaces It Cannot Join

The assistant must never appear in:

- channel invite/bind UI
- meeting/call participant selection
- workflow step targets
- trigger targets
- generic public agent directory
- cross-agent mailbox addressing

This is the main surface-level difference between it and a normal shared agent.

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
- meeting/call flows must reject `agentKind = personal_assistant`
- agent discovery/listing must hide personal assistants from normal lists
- delegated tools must run with effective user permissions
- memory capture/retrieval must apply the `user + personal_assistant` filter

If those checks are solid, the rest of the system can stay mostly normal.

## 11. What We Are Deliberately Not Doing In MVP

Do not add these yet:

- per-user cloned agent instances
- separate personal assistant template/instance tables
- auto-promotion of workspace conversations into PA memory
- admin-created arbitrary managed assistants
- support for bringing the assistant into shared channels
- broad destructive write delegation

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
- one private assistant-memory namespace per user
- live workspace read/write using the user's own permissions
- no shared surfaces

That is much simpler than the previous design, and it is compatible with the
direction we now want for the rest of the agent system.

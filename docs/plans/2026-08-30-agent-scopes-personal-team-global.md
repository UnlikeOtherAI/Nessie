# Personal, team, and global agents — scopes, directory visibility, and the PA exception

**Status:** design proposal for review — no code changes yet.
**Date:** 2026-08-30
**Related:** [2026-08-29-people-and-their-agents.md](2026-08-29-people-and-their-agents.md)
(ownership = stewardship; this doc adds *visibility*, a different fact),
[2026-08-15-uoa-org-tenancy.md](2026-08-15-uoa-org-tenancy.md),
[docs/done/2026-08-29-org-chain-of-command-superseded.md](../done/2026-08-29-org-chain-of-command-superseded.md).
**Reviewed:** independent parallel reviews by Codex Sol and kimix on the same
brief; every claim verified against code before adoption. Agreements,
disagreements, and adjudication: §"Cross-model review".

## The product rules (the spec)

1. **Global agents** — default agents provided by the app itself. Vendor
   designed; available to everyone in every org/workspace. App-provided, not
   user/team-owned.
2. **Team agents** — available to everyone within the team/workspace. Can be
   added to projects, conversations, and channels.
3. **Personal agents** — visible ONLY to their owner. The owner is the only
   person who can see and find them in the directory. Personal agents cannot
   be added anywhere — not to projects, conversations, or channels.
   - **The one exception is the Personal Assistant.** It is the only personal
     agent that can be added to a conversation/channel. To its owner it shows
     as "Personal Assistant"; to everyone else it shows as
     "\<Owner name\> – PA" with the PA's avatar, so other people in a shared
     conversation can hand that person's PA a task.

## What exists today — verified against `main`, 2026-08-30

The task brief carried two claims that are now stale; both are corrected here
because the design changes shape around them.

- **`Agent.ownerUserId` exists.** The brief said the model has no per-user
  ownership; migration `20260829170000_agent_owner_stewardship` added it two
  days ago (people-and-their-agents phases 1–2, landed). It is *stewardship* —
  attribution and an extra visibility arm — with a composite tenancy FK to
  `organization_members` and a CHECK forbidding it on `systemManaged` or
  org-less rows. It is deliberately **not** a privacy fence: an owned agent is
  still visible to anyone who reaches it through a channel binding.
- **The scope tabs already exist, derived, not stored.**
  `admin/src/components/features/agents/agent-scope.ts` derives
  `personal_assistant → Personal`, `systemManaged → Global`, else `Team`, and
  `listAgentsForUser(includeSystemManaged)` feeds them. So "Personal" today
  means exactly one thing: the PA. There is no way to author a private agent.

The rest of the relevant machinery, each fact load-bearing below:

- **A DB CHECK locks the agent shape to three combinations**
  (`agents_system_managed_invariants_chk`,
  migration `20260706170500_system_managed_shared_agents`):
  user-authored `(systemManaged=false, shared, shared, none)`;
  the PA `(true, personal_assistant, dm_only, act_as_requesting_user)`;
  system shared `(true, shared, shared, none)` — the Librarian tier.
- **The PA is one row per organisation** (`ensurePersonalAssistantAgent`,
  advisory-locked, `api/src/services/personal-assistant.ts`), projected
  per user through a private DM channel `dmKey = pa:{orgId}:{userId}` in a
  system team, whose membership is forcibly reduced to exactly the one user
  (`ensurePersonalAssistantChannel` deletes every other `ChannelMember`). One
  avatar per org, generated once (`personal-assistant-avatar.ts`).
- **The PA acts as a person only via `effectiveUserId`**, stamped on the
  orchestration actor context **only when the channel's `systemChannelType`
  is `personal_assistant`**, and stamped **with the poster's id**
  (`api/src/routes/thread-message-create.ts:311-317`). That equality
  (effective user = poster) is safe today *only because* the PA DM has exactly
  one member. Everything personal about a PA run — user-scope MCP connectors,
  comms connections, memory, the disclosure viewer — keys off this.
- **Binding is a single chokepoint with structural refusals.**
  `bindAgentToChannel` (`packages/workspace-admin/src/agent-bindings.ts`)
  returns null for any `systemManaged` agent and for any `personal_assistant`
  system channel; `unbindAgentFromChannel` likewise refuses. The route
  (`POST /api/agents/:agentId/bindings`), the PA `agent_bind_channel` tool,
  and the @mention invite flow (`agent-invite-reply.ts` +
  `useChannelComposer` pending invites) all resolve to it.
- **Visibility is entitlement through channels plus ownership.**
  `listAgentsForUser` = agents bound into a channel the caller can see
  (public, or membership) OR `buildOwnedAgentWhere` (live membership +
  `parentAgentId: null`); org owners additionally see unbound agents.
  `isAgentVisibleToUser` mirrors it exactly and **hard-codes
  `systemManaged: false`** — so every per-agent read (detail, status,
  activity, children-after-the-scope-fix) 404s on the PA and on global
  agents; they are list-only.
- **Mention typeahead inherits the entitled list.** `useChannelMentions`
  builds `@` entities from the agents the page already fetched — the
  `listAgentsForUser` result — so the client never sees a name the server
  would withhold. Server-side, `message-create.ts` records mention metadata
  and treats a mention of a *non-member* agent as a pending invite, never a
  silent pull-in.
- **`agent.updated` realtime publishes to the whole organisation** with a
  payload of `{agentId}` only (`api/src/routes/agents.ts:322-328`); clients
  refetch through the entitled list.
- **"Conversations" and "channels" are one table.** `Channel` covers named
  channels, user DMs, PA DMs, and external-agent DMs, distinguished by
  `type`/`dmKey`/`systemChannelType`. "Added to a project" has no direct
  mechanism today: `Agent.projectId/teamId` exist but are used only as trigger
  launch-origin context, and project reach is via the project's channels. This
  design treats "addable to projects/conversations/channels" as one rule —
  addable to *channels* (of any kind) — because that is the only attachment
  primitive that exists, and inventing a second one would fork the surface.

## The design in one paragraph

Add **one new stored fact, `Agent.visibility` (`workspace` | `private`)**, and
keep everything else derived. Global stays `systemManaged` (app-provided rows
instantiated per org by bootstrap, exactly the Librarian/PA pattern). Team
agents are today's user-authored shared agents, `visibility = workspace`,
unchanged behaviour. Personal agents are `visibility = private`: owner
required, directory-visible to the owner alone, structurally refused by the
binding chokepoint, homed in an auto-provisioned owner-only DM. The PA
exception is built as **per-user presence on the org-singleton PA row** — a
`principalUserId` on the binding, mirrored onto the messages and runs it
produces — so "whose PA is in this room" is a structural fact the server
stamps, never a display trick. Scope precedence for rendering:
`agentKind=personal_assistant → Personal (PA)`, else `systemManaged → Global`,
else `visibility=private → Personal`, else `Team`.

## Why a new column, and why this one

Three existing fields look tempting and each is wrong:

- **`ownerUserId` alone cannot mean private.** Ownership is stewardship —
  every team agent should eventually have an owner too (that is the whole
  point of people-and-their-agents). Deriving "private" from "has an owner"
  would make stewarding a shared agent hide it from the team, and make a
  personal agent's privacy evaporate on transfer-to-null. Visibility and
  stewardship are two facts; conflating them re-creates the drift the derived
  scope tabs were built to avoid.
- **`surfacePolicy` is worker exposure, not directory visibility.** `dm_only`
  governs where an agent may *act*; the PA is `dm_only` yet must appear in
  shared channels under this spec. Overloading it would give one enum two
  jobs that this very feature needs to move independently.
- **`agentKind` is behaviour.** `personal_assistant` selects the PA toolset,
  delegation mode, and bootstrap; a personal *agent* is an ordinary agent
  with a narrow audience, not a second PA.

So:

```prisma
enum AgentVisibility {
  workspace   // default — today's behaviour, team agents
  private     // owner-only
}
Agent.visibility  AgentVisibility  @default(workspace)
```

```sql
-- private is meaningless without a live-resolvable owner, and system rows
-- (PA, Librarian, external products) are never private: the PA's audience
-- is per-DM already, and hiding a bootstrap row would orphan it.
ALTER TABLE agents ADD CONSTRAINT agents_private_visibility_chk CHECK (
  visibility = 'workspace'
  OR (owner_user_id IS NOT NULL AND system_managed = false)
);
```

This composes with, and does not touch, the existing
`agents_system_managed_invariants_chk` and the stewardship CHECK. Migration is
additive: every existing row defaults to `workspace`; nothing is backfilled to
`private` because nothing today was authored with a privacy expectation the
data can prove.

**Deliberately not built:** a `team` visibility value scoping an agent to one
UOA workspace. Today's "team agents" are org-visible through channel
entitlement, and narrowing them by `Agent.teamId` would need the same
entitlement care as everything else (a member of the team, not the session
claim). Nothing in the spec requires it — "available to everyone within the
team/workspace" is what channel-entitlement already delivers in a
one-workspace-per-team world — so it stays out until a real multi-team
tenancy need names it. If it ever lands it is a third enum value plus one
where-branch, not a redesign.

## Global agents — app-provided, instantiated per org

**Global = `systemManaged = true`, and "provided by the app" means a bootstrap
in code, not a cross-org row.** This is already how the PA, the Librarian, and
external-agent products work: an `ensure…` function holding the canonical
config, advisory-locked, run at login/provision time, updating the org's row
in place. Keep that pattern for the vendor's default agents:

- One **app-defined blueprint registry** (code + config, versioned with the
  deployment) → one `systemManaged` row per organisation, created/updated by
  bootstrap. Updates ship by redeploying: the ensure function re-applies the
  blueprint (the PA's config-merge under the per-agent policy lock is the
  template, including the "never clobber a targeted grant" rule).
- **Why not org-less rows** (`organizationId = null`, which the schema
  permits): every read path scopes by `organizationId`; runs, bindings,
  budgets, the token ledger, and disclosure all assume a tenant. A shared
  cross-org row would be the "flatten several orgs into one container"
  violation the UOA invariant names, this time for agents. Per-org
  instantiation keeps tenancy, per-org tool grants, and per-org audit intact
  while the *definition* stays vendor-owned.
- **Reachability (Rule zero).** Today global agents are list-only:
  `bindAgentToChannel` refuses `systemManaged` and `isAgentVisibleToUser`
  hard-codes `systemManaged: false`, so they have no detail page and cannot
  be added to a channel by anyone. "Available to everyone" that nobody can
  put to work anywhere is exactly the unreachable-capability defect. Two
  decisions, recommended together:
  1. Binding: allow binding a `systemManaged` **shared** agent (never the
     PA) to ordinary channels, gated like any bind (`checkPolicy('agent',
     'bind')` + channel membership + owner). The refusal narrows from
     `isSystemManagedAgent(agent)` to `agent.agentKind === 'personal_assistant'
     ? <PA presence path> : false` — see the PA section for why the PA gets
     its own gate rather than reusing this one.
  2. Read: a **read-only detail view** for global agents (config visible,
     edit menu absent — the derived-scope `isAgentScopeEditable` already
     encodes this client-side; the server needs the matching gate:
     `PUT`/`DELETE` keep refusing `systemManaged`).
- **Directory:** unchanged — the Global tab lists them via
  `includeSystemManaged`, still filtered by channel entitlement, with one
  correction: a vendor default agent that is *not yet bound anywhere* is
  invisible to everyone except org owners today. Bootstrap should either bind
  each default agent to `#general` at provision time, or the Global tab
  should list unbound `systemManaged` rows for every member (they are
  app-provided and hold no secrets). Recommended: the latter — one
  `visibilityFilters` branch `{ systemManaged: true }` when
  `includeSystemManaged` is set, so availability does not depend on a
  binding accident.

## Team agents — today's shared agents, now with a name

`visibility = workspace`, `systemManaged = false`. No behavioural change:

- **Creation:** `POST /api/agents` / PA `agent_create`, member-level, exactly
  as today; `ownerUserId` stamped per people-and-their-agents.
- **Placement:** bindable to channels of any kind except system channels —
  the existing chokepoint. "Add to a project" remains "bind to that project's
  channels"; "add to a conversation" is binding to a DM/group channel, which
  the chokepoint already permits.
- **Directory:** the Team tab, entitlement-scoped as today.

The only new code is the visibility filter (below), which for these rows
matches everything and changes nothing.

## Personal agents — `visibility = private`

### Creation and home surface

- **Creation:** the same member-level create paths grow a `visibility`
  field (Designer toggle "Only visible to me"; `agent_create` parameter).
  The creator becomes `ownerUserId` (already true) and the CHECK holds.
- **A personal agent must be reachable somewhere or it is dead on arrival**
  (Rule zero), and "addable nowhere" forbids every shared surface. So
  creating a private agent auto-provisions its home: a private DM channel
  `dmKey = agent:{orgId}:{ownerUserId}:{agentId}`, single member = owner, in
  the owner's team, bound via the *bootstrap* path
  (`ensure…Binding`-style direct upsert) — deliberately outside
  `bindAgentToChannel`, exactly as the PA's own DM binding already is. The
  existing `dm_key LIKE 'pa:%'` style CHECKs must admit the new prefix in the
  same migration (the `extagent:` precedent shows what happens when a new DM
  key shape is added without updating the constraint — it ships violating a
  committed CHECK).
- Deleting the agent (when agent deletion exists) or transferring it owns the
  DM's fate; transfer of a private agent re-homes the DM to the new owner —
  but see Open questions: transfer of a *private* agent is arguably a
  contradiction and the simpler rule is "publish first, then transfer".

### Directory and read-path gating — the leak surface, enumerated

One where-fragment, stated once and composed everywhere the entitled agent
set is computed:

```ts
// packages/workspace-admin — beside buildOwnedAgentWhere
export const buildAgentVisibilityWhere = (viewerUserId: string) => ({
  OR: [
    { visibility: 'workspace' },
    { visibility: 'private', ...buildOwnedAgentWhere({ organizationId, userId: viewerUserId }) },
  ],
})
```

Note the private arm reuses `buildOwnedAgentWhere`, so it inherits the
**live-membership** re-derivation and the `parentAgentId: null` guard — a
deactivated owner loses sight of their private agents the same way they lose
everything else, and subtask children do not flood the list.

Read paths that must compose it, each verified to exist:

| Path | Today | Change |
|---|---|---|
| `listAgentsForUser` (`GET /api/agents`, PA `agent_list`, Agents page, mention entities, people-agents tree, `listAgentsWithAppAccess`) | channel-entitlement OR owned | AND the visibility fragment. Mentions/tree/app-store inherit for free — they all consume this list |
| `isAgentVisibleToUser` / `isAgentAccessibleToActor` (agent detail, status, activity, messages, tools, children scope) | mirrors the list | mirror the fragment — **including the org-owner fast path**: an org owner sees every workspace agent but NOT other people's private agents; "private means private" beats the owner's all-agents entitlement. This is the one place the rule is stronger than today's model |
| `createAgentVisibilityScope` consumers (`agent-read-model` status/activity/children) | channel-scoped | inherit via the predicate above |
| **Pending-invite scan** (`message-create.ts:218-233`) | loads **every** non-system shared agent in the org and regex-matches names against any `@`-bearing message — an org-wide name oracle the moment private agents exist (existence + id confirmed to any member, and the composer offers to bind it) | the `findMany` composes the visibility fragment for the message author (kimix finding, verified) |
| Trigger lists (`trigger-crud.ts:52,108` — `listOrganizationTriggers`, scheduled sweep list) | filter by `agentKind IN (shared, personal_assistant)` + org, no ownership arm | a private agent's triggers are as private as the agent: compose the fragment (owner-gated surface, but org owners are exactly who must not see these) |
| `listAgentToolPolicyTargets` (`agent-tool-policy.ts:51`) + DeepWater target lists | enumerates all shared non-system agents org-wide for owner surfaces | exclude private agents not stewarded by the caller — an owner cannot meaningfully administer tools on an agent they may not see |
| `GET /api/runs/active` (`api/src/routes/runs.ts:44-52`) | **member-level** (`requireActorContext` only) and returns every active/restartable run in the org with agent linkage | compose the visibility fragment (Sol finding, verified). Machine-only today, but "machine-only" is not "leak-proof" |
| Task/workflow agent references (`Task.assigneeAgentId`, workflow agent steps) | validated for existence | validation must use the *actor's* entitled predicate so a private agent cannot be assigned work by a non-owner, and its name never renders on a board it did not join |
| Channel-member/agent surfaces (`ChannelAgentInfoDrawer`, channel agent lists) | bound agents only | no change needed — a private agent is never bound to a shared channel, structurally |
| Realtime `agent.updated` | org-broadcast, id-only payload | acceptable: the id leaks existence-of-change only; clients refetch through the gated list. Do **not** start enriching this payload with names without re-checking this row |
| Audit log | owner/org surface | audit is an owner-gated compliance surface; private agents appear there by design (owners audit, they do not browse the directory) — document, don't hide |

**Search:** the search route does not index agents; message content authored
*by* a private agent lives only in its owner-only DM, which message search
already scopes by channel visibility. No new search work — but the rule for
future work is the disclosure-sink rule restated: any new read that returns
agent identities composes `buildAgentVisibilityWhere` in the same change.

### Placement — refused at the chokepoint, everywhere

`bindAgentToChannel` gains one refusal: `agent.visibility === 'private'`.
Because the route, the PA `agent_bind_channel` tool, and the mention-invite
flow all funnel through it, one edit covers every doorway;
`unbindAgentFromChannel` needs no change (nothing private is ever bound
through it). Three hardenings, all adopted from the cross-model review:

- **Refuse in words, not with the silent `null → 404`.** The owner binding
  their *own* private agent is a legitimate, explainable mistake; return a
  reason-coded 403 (`AGENT_VISIBILITY_PRIVATE`) so the composer's existing
  per-agent `inviteErrors` rendering can say why (the `connector_*`
  "visible, refuses in words" precedent).
- **A `BEFORE INSERT` trigger on `agent_bindings` as the storage-level
  floor.** The chokepoint discipline has been bypassed before — the codebase
  itself records that `spawn_subtask` writes agents outside
  `createAgentRecord`; `ensurePersonalAssistantBinding` writes bindings
  outside `bindAgentToChannel`; and `createGroupFromDm`
  (`api/src/services/channel-dms.ts:145-300`) **copies a DM's agent bindings
  onto the new group channel with a raw `agentBinding.upsert`** — a live
  writer both external reviewers' bypass argument predicted and Sol actually
  found. A CHECK cannot span tables; a small trigger (reject when the
  referenced agent is `private` and not the PA kind) is immune to the next
  bypass, and the DeepWater cost-write trigger is the in-repo precedent for
  constraint-by-trigger.
- **A run-start assertion in the worker.** Nothing at dispatch time re-checks
  `surfacePolicy` or visibility — the orchestrator honours whatever binding
  rows exist. A stale or hand-inserted binding should fail closed: when the
  run context loads a `private` agent, assert the destination is its
  owner-DM or its own trigger thread, else fail the run before inference.

**Triggers and schedules:** a private agent's triggers are creatable only by
its owner (org owners cannot see it, so `agent_trigger_create`'s
"agent accessible" gate already narrows to the owner). Scheduled triggers
carry the owner's UOA identity as launch origin; when the owner is
deactivated, the existing origin-verification path moves the trigger to
`needs_reauthorization` and alerts — the "schedule that stops says so"
machinery needs **one adjustment**: its health alert goes to org owners, who
cannot see this agent. For a private agent the alert recipient set is the
owner alone; if the owner is the one deactivated, the trigger stays parked
and surfaces on reactivation. No silent forever-firing ghost, no disclosure
to non-owners.

**Owner deactivation is a lifecycle event for private agents — an explicit
exception to "ownership is never lifecycle".** People-and-their-agents
decided an owned agent keeps executing when its owner leaves, and for
workspace agents that stands. A private agent whose owner is deactivated has
an audience of zero: triggers firing, spend accruing, nothing anyone can see.
So deactivation **pauses** the member's private agents (their triggers
disabled with a durable owner alert, per the transition-owns-the-signal
rule), and org owners see *existence without content* — a "N paused private
agents" line in the people-tree's buckets, no names, no prompts — so an admin
can act on the spend without reading private configuration. Reactivation is
explicit, mirroring `POST /api/triggers/:id/reauthorize`. The
people-and-their-agents doc gets amended with this carve-out in the same
change (documentation rule), and AGENTS.md gains one sentence recording that
private visibility is the sanctioned exception to owner-sees-everything —
without it, every future reviewer will "fix" the exclusion back.

**Runs and delivery:** a private agent's runs happen in its owner-only DM
(or its own triggers' threads, which live there too), so budget stops,
thinking bubbles, and checkpoints all render to an audience of one with no
new code.

**`spawn_subtask` children of a private agent inherit `visibility =
'private'`** (and the owner, as already shipped). Without this, a private
agent's delegated work would mint workspace-visible rows narrating its task.
One line in the raw `tx.agent.create` beside the owner inheritance.

## The Personal Assistant exception — per-user presence on the singleton

### Why not per-user PA rows

The honest alternative is to end the org-singleton and mint one PA `Agent`
row per user. It would make everything downstream trivial — `Message.agentId`
alone would disambiguate whose PA spoke, bindings need no new column, the
owner arm is a real `ownerUserId`. It is rejected here, for now, because the
singleton is load-bearing far beyond chat: the DeepWater launcher and
`/api/integrations/products/deep-water/agent-access` manage the 6/6 grant
bundle against *the* PA row; `ensurePersonalAssistantAgent` merges org-level
PA config under one policy lock; integration handoffs, favorites
(`favorites.ts:104` special-cases the PA kind), and the stewardship CHECK
(`owner ⇒ ¬systemManaged`) all assume it. Fanning all of that out per user —
plus a migration that must retire the singleton as a historical identity and
reassign old runs/messages by thread provenance — is a program of work, not
a column, and the spec needs none of it: per-user *presence*, not per-user
*configuration*, is what the shared-channel behaviour requires.

**The honest cost of keeping the singleton** (Sol's counter-argument,
recorded because it is real): everything that identifies an actor by
`agentId` alone becomes ambiguous inside a shared channel and needs the
presence key threaded through — `Message` (new `onBehalfOfUserId`),
run-slot/rate-limit keying, mention metadata, the channel agent drawer, and
`MessageReaction`/the 👀 working-marker (both `(message, agent)`-keyed; two
presences of one agentId collide). The presence design accepts that
threading for the handful of surfaces a presence actually touches, and
constrains the marker/reaction ambiguity by policy (a presence run's
reactions carry the same `onBehalfOfUserId` stamp via its message chokepoint;
the working marker tolerates the collision — "a PA is reading this" is
adequate). If per-user PA personalisation (own prompt, own model) ever
becomes product, that is the moment to convert presences into real per-user
rows; the presence table is designed to migrate row-for-row.

### The structural unit: `AgentBinding.principalUserId`

"Ondra's PA is in #launch" is a fact about a **binding**, not about the agent
(one org row) or the channel (many people's PAs may join). So:

```prisma
AgentBinding.principalUserId  String?  @db.Uuid   // null for every ordinary binding
```

- Uniqueness splits: `UNIQUE (agent_id, channel_id) WHERE principal_user_id
  IS NULL` (today's rule, unchanged for ordinary agents) plus
  `UNIQUE (agent_id, channel_id, principal_user_id) WHERE principal_user_id
  IS NOT NULL` — so two people's PAs coexist in one channel as two rows, and
  one person's PA joins once.
- CHECK: `principal_user_id IS NULL OR` the binding's agent is the PA kind —
  enforced in the service (the agent row is in another table; a trigger is
  overkill for a single guarded write path).
- Tenancy: same composite-FK pattern as `Agent.ownerUserId` —
  `(organization-of-channel, principal_user_id)` must be a member; in
  practice the write path derives both inside one transaction, and the
  existing membership check covers it.

**Placement gate (the consent boundary).** A new, deliberate write path —
`POST /api/channels/:channelId/personal-assistant` (+ the symmetric DELETE),
surfaced as "Add my assistant" in the channel's member/agent management UI
and as a PA tool (`pa_join_channel`) so you can just tell your assistant to
join. Gates: caller is a **member of the channel** (`getChannelIfMember`),
the channel is not a system channel, and `principalUserId` is **always the
caller** — nobody can add someone else's PA, and nobody can add their PA to
a room they are not in. Removal: the principal themself, or anyone who
`canManageChannel`. This is placement-time consent: the owner is the only
person who can put their PA in a room, which is what makes "others may task
it" acceptable downstream. `bindAgentToChannel` keeps refusing the PA
entirely; this route is the *only* writer of principal bindings, mirroring
how the PA DM binding is the only writer of the singleton's DM bindings.

### Identity on every message and run

The presence must flow to everything the PA does in that room, or the display
is a lie and the security model has a hole:

- **`Message.onBehalfOfUserId`** (nullable) — stamped by the worker's message
  chokepoint (`agent-message.ts`) from the run's presence. Rendering,
  routing, and audit read it; it is never inferred from content.
- **`Run` already carries the answer**: the orchestration actor context's
  `effectiveUserId`. The change is *where it comes from*. Today
  `thread-message-create.ts` stamps `effectiveUserId = poster` only in PA
  system channels. New rule, structural:
  - PA DM (`systemChannelType = 'personal_assistant'`): unchanged —
    effective user = poster = the DM's one member.
  - Shared channel with PA presences: each presence is its own candidate
    agent for engagement, and a run launched for a presence sets
    **`effectiveUserId = binding.principalUserId`** — the PA acts as its
    *owner*, never as the poster. The poster is `requestedByUserId` /
    `actor` — attribution, not identity. This is the single most important
    line in the design: without it, anyone posting near a PA presence would
    execute with the poster's own delegated identity stamped by the old rule,
    or worse, with the owner's tools attributed to nobody.
- **UOA delegation follows the effective user** exactly as PA runs already
  do — `X-UOA-Delegation` minted for the *owner*, which is correct: the
  work is done by the owner's assistant under the owner's authority, on
  another member's request.

### Engagement — how a stranger's task reaches my PA

The orchestrator's `channelAgents` assembly expands: a presence contributes
one candidate entry `{agentId: PA, principalUserId}` alongside ordinary bound
agents. Addressing stays **model-judged** (the no-string-matching rule):
"@Ondra's PA, book the room" or Czech slang aimed at it is the model's call,
with two structural assists:

- **The mention entity for a presence is structured and id-keyed, never
  name-matched.** Today the server re-derives agent mentions from content by
  name regex (`mentionedAgentIdsFromContent`); with two PAs in a room and
  duplicate human display names, names are inherently ambiguous, and both
  external reviewers independently landed on the same rule: typeahead stores
  `{type:'agent', agentId, principalUserId}` in the message's mention
  metadata, the server validates that exact presence is bound to that exact
  channel, and plain-text "@PA" resolves to nobody. Ordinary agents keep the
  existing name path; presences are structured-only from day one.
- The engagement decision for an *unaddressed* message stays model-judged
  like any bound agent's, and may pick at most one presence — the
  one-run-per-slot discipline keyed per presence:
  `(agentId, principalUserId, threadId)`.

**The canonical stored name is the public one.** Mentions are recorded and
re-derived from message *content* (`mentionedAgentIdsFromContent`,
`message-create.ts`), and content is one string for every reader — it cannot
vary per viewer. So the stored/canonical token for a presence is
"\<Owner\> – PA" for everyone, **including the owner**; the owner's composer
*offers* "Personal Assistant" in typeahead but inserts the canonical form,
and the owner's client renders it back as "Personal Assistant" (a pure
display projection keyed on `onBehalfOfUserId === viewerId` /
`principalUserId === viewerId`). Message author chrome follows the same rule:
name + the org PA avatar, "Personal Assistant" to the owner,
"\<Owner\> – PA" to everyone else. The PA's own *DM* keeps its current
"Personal Assistant" label untouched.

### Privacy — the confused-deputy problem, and what already contains it

A PA presence is a privileged agent (owner's connectors, comms, memory,
private channels) taking instructions from people who are not its owner in a
room its owner does not control. Three existing mechanisms carry most of the
weight, with two adjustments:

1. **Disclosure basis already prevents laundering.** Everything the run reads
   through scoped sources feeds `ConsumedSourceSink`; `computeReplyBasis`
   stamps the remainder on the shared-channel reply, and readers who don't
   satisfy the basis get a withheld row. A stranger asking my PA "what's in
   Ondra's inbox?" produces a reply whose basis the stranger cannot satisfy.
   No new machinery — but the obligation ("every read feeds the sink in the
   same change") now guards a sharper edge and is worth restating in the PA
   presence's own doc block.
2. **Containment must flip ON for presences — and today's exemption would
   silently not.** `retrieveRelevantMemories`
   (`worker/src/run/execute/memory.ts:130-175`) computes
   `isPersonalAssistant` as `channel.systemChannelType === 'personal_assistant'
   || agent.agentKind === 'personal_assistant'` and exempts that from
   `constrainScopesToDestination`, justified in its own comment by "a DM whose
   only human is that owner". A presence run satisfies the **second** disjunct
   while breaking the justification: same agent kind, shared room. Ship the
   presence feature with the exemption re-keyed to the *surface*
   (`systemChannelType`), never the kind — exempt in the PA DM, contained
   everywhere else. This is the one place the existing code would actively do
   the wrong thing rather than merely lack a feature.
3. **A presence run is reduced-capability by default; the owner's private
   estate is behind explicit elevation.** All three reviewers converged on
   the two principals being distinct — the *requester* (the member who
   addressed the PA: attribution, abuse limits) and the *principal* (the
   owner: identity, delegation, billing) — and on the run never falling back
   to the requester's identity. Where they differed was the default posture
   (see §Cross-model review); the adjudicated rule, expressed with existing
   machinery rather than a new mode enum, is **surface-keyed capability**,
   the same structural key the containment fix uses:
   - In the PA DM (`systemChannelType = 'personal_assistant'`): full PA
     toolset, exemptions intact — unchanged.
   - In a shared channel (a presence run): identity is the owner's
     (`effectiveUserId`, UOA delegation, billing attribution — kimix's four
     points stand), but the toolset assembly withholds the owner-private
     tier: user-scope connectors, comms tools, and owner-private
     knowledge/memory reads are either absent or routed through the existing
     approval machinery addressed to the owner. Reads that remain are
     destination-contained (point 2). "Book the room in this channel's
     project" works on a stranger's word; "read Ondra's inbox" produces an
     approval request in Ondra's PA DM, not an action. Free-text owner
     promises ("my colleagues may ask it anything") are never the gate — the
     chokepoints are.
4. **The owner sees what their PA was told, and can leave.** The owner is a
   member of every room their PA is present in (the placement gate), so the
   activity is visible where it happens; elevation requests land as durable
   items in the owner's PA DM (deduped per run via the existing
   `user_alerts (user_id, event_key)` uniqueness); and the unbind control —
   the kill-switch — sits on the channel's agent panel next to the presence
   chip. A per-run digest beyond that is a later nicety.
5. **Non-owners get a participant projection, never the `AgentRecord`.** The
   full record carries the system prompt, tool policy, run limits, and
   channel ids; none of that belongs to a channel-mate of the owner's PA. The
   channel drawer and member list render presences from a minimal shape —
   stable id, viewer-relative display name, PA marker, avatar, presence —
   and every `/api/agents/:id/*` detail read keeps 404ing for non-owners
   exactly as `isAgentVisibleToUser`'s `systemManaged: false` arm already
   makes it do (Sol's point, adopted; it is nearly free because the 404 is
   the status quo).

### Lifecycle edges

- **Owner leaves the channel** → presence removed in the same transaction
  (the placement gate's invariant "principal is a member" must stay true at
  rest, not just at insert). `ChannelMember` deletion cascades the presence.
- **Owner deactivated** → presence bindings deleted (or skipped at
  engagement-assembly time via the live-membership predicate — delete is
  cleaner: no ghost row, an audit event, and re-adding on reactivation is one
  click). The PA singleton itself is untouched.
- **Channel deleted/archived** → bindings already cascade.
- **The PA DM remains single-member** — presences change nothing about
  `ensurePersonalAssistantChannel`'s member-reduction.

## Interaction with people-and-their-agents — one grid, two axes

Ownership (who stewards) and visibility (who may see) are orthogonal and both
now exist:

| | `visibility=workspace` | `visibility=private` |
|---|---|---|
| `ownerUserId` set | team agent with a steward (normal) | personal agent (CHECK requires this) |
| `ownerUserId` null | unowned team agent / global (`systemManaged`) | forbidden by CHECK |

- The people-agents tree needs no change: level 3 already intersects with the
  viewer's `listAgentsForUser`, so my private agents appear under my row *to
  me* and are absent from my row for everyone else — no hidden counts, per
  the existing rule.
- The org tree stays a read-time JOIN; no new hierarchy, no UOA duplication —
  `visibility` is a fact about a Nessie object, like `ownerUserId`.
- Transfer: private agents are excluded from transfer in v1 (publish → then
  transfer). This keeps transfer's disclosure analysis (already subtle)
  untouched by privacy.

## New vs reused

| Need | New | Reused |
|---|---|---|
| Personal scope | `Agent.visibility` + CHECK + migration | `ownerUserId`, `buildOwnedAgentWhere`, live-membership derivation |
| Directory gating | `buildAgentVisibilityWhere`, composed into the predicates + the enumerated stray readers (invite scan, trigger lists, tool-policy targets, runs/active) | `listAgentsForUser` / `isAgentVisibleToUser` mirror-pair discipline |
| Personal home | `agent:{org}:{owner}:{id}` DM + bootstrap binding | PA DM machinery, `ensureDefaultThread`, DM key CHECK pattern |
| Placement refusal | one branch in `bindAgentToChannel` (reason-coded 403), `agent_bindings` BEFORE-INSERT trigger, worker run-start assertion | the single binding chokepoint + its callers; DeepWater trigger precedent |
| PA presence | `AgentBinding.principalUserId` (+ split uniques), presence route + PA tool, `Message.onBehalfOfUserId`, participant projection record, per-run owner alert | org-singleton PA, `effectiveUserId` machinery, disclosure basis, approvals, `user_alerts` dedupe |
| Dual display + addressing | render-time projection keyed on principal; structured id-keyed mention entities for presences | `User.displayName` mirror, org PA avatar, mention metadata plumbing |
| Presence capability | surface-keyed toolset reduction + containment re-key (`memory.ts` exemption → surface, not kind) | approval machinery, `constrainScopesToDestination`, `ConsumedSourceSink` |
| Owner-deactivation handling | pause private agents + durable alert + existence-only admin bucket | trigger `needs_reauthorization` machinery, people-tree buckets |
| Global agents | blueprint registry + bootstrap per org; unbound-global list branch; read-only detail gate | `ensurePersonalAssistant*` pattern, `systemManaged` tier, derived scope tabs |

**Not built:** per-user PA rows, a `team` visibility value, a second binding
table, any per-viewer message *content*, cross-org agent rows, digest streams
beyond the elevation alerts, personal-agent transfer, a `GlobalAgentDefinition`
catalog table, an `AgentTeamScope` publication join.

## Cross-model review — Codex Sol and kimix

Both reviewers received the same brief, worked independently against the
repo, and delivered full designs. Every claim cited below was re-verified
against code before being accepted or rejected; three of their findings were
confirmed line-by-line and changed this document.

### Where all three designs agree

- Personal scope must be a **stored, DB-constrained fact**, never derived
  from `ownerUserId` (stewardship widens visibility; it must not narrow it),
  `agentKind`, or `surfacePolicy`.
- **Nothing is backfilled to private** — no existing row was authored with a
  privacy expectation the data can prove (the ownership plan's own
  no-fabrication rule).
- Global agents stay **per-org instantiated** rows; a shared cross-tenant
  executable row is the org-flattening violation in a new costume. (Sol
  additionally wants a versioned definition catalog — see disagreements.)
- The org-owner omniscience arm of `isAgentAccessibleToActor` must **not**
  see other people's private agents — private beats the owner entitlement,
  and AGENTS.md gets a sentence saying so, or a future reviewer "fixes" it.
- The PA-in-channel principal is a **structural fact stamped by the server**
  (binding-level user id), the run's identity is the **owner's, never the
  requester's**, and PA addressing is **structured mention entities, id-keyed**
  — name-matching "@PA" is ambiguous and forbidden.
- Placement refusal lives in the shared chokepoint **plus** a storage-level
  floor, because raw binding writers exist.

### Confirmed findings adopted from the reviews

1. **The pending-invite scan is an org-wide name oracle** (kimix; verified at
   `message-create.ts:218-233`). Any `@`-bearing message regex-matches
   against *every* non-system shared agent in the org — existence, id, and a
   bind offer for agents the viewer is not entitled to see. Fixed in the
   read-path table.
2. **`createGroupFromDm` is a live raw binding writer** (Sol; verified at
   `channel-dms.ts:145-300`) — it upserts agent bindings outside
   `bindAgentToChannel`, which converts the DB-trigger recommendation from
   paranoia to necessity.
3. **`GET /api/runs/active` is member-level and org-wide** (Sol; verified —
   `requireActorContext` only). Added to the gating table.
4. **Trigger lists and tool-policy target lists enumerate org-wide with no
   ownership arm** (kimix; verified at `trigger-crud.ts:52,108`,
   `agent-tool-policy.ts:51`). Added.
5. **The memory-containment exemption keys off `agentKind`, not the
   surface** (both flagged the area; the precise mechanics in this doc are
   from direct verification of `memory.ts:130-175`). kimix stated the PA
   "goes through `constrainScopesToDestination`" — half right: the mode is
   PA, but the containment call is *skipped* for the PA, which is exactly
   why a presence run would inherit the exemption unless it is re-keyed.
6. **`trigger-create.ts:83` already rejects PA-kind agents** (Sol) — so "PA
   triggers" need no new refusal, and personal-agent triggers are a free
   design choice, not a constraint.

### Disagreements and how they were resolved

**Singleton PA + presence vs real per-user PA rows.** kimix: keep the
singleton, add a per-user binding column. Sol: convert to per-user rows,
because everything keyed by `agentId` alone (messages, reactions, runs,
mentions, realtime, rate limits) becomes ambiguous, and a projection id must
otherwise be threaded through all of it. **Resolved: keep the singleton with
binding-level presence for this spec, with Sol's cost list recorded verbatim
in the design** (§"The honest cost"). The deciding facts: the spec needs
per-user *presence and identity*, not per-user *configuration*; the
singleton is pinned by DeepWater's 6/6 bundle, org-level config merge, and
integration handoffs, which per-user rows would fan out per head; and Sol's
own migration plan (retired historical row, thread-provenance reassignment)
is the largest single work item in either review for a benefit the spec does
not ask for. The conversion is named as the committed path *if* per-user PA
personalisation becomes product.

**Default authority of a presence run.** kimix: the PA acts as the owner,
full stop — containment + basis + bind-time consent + per-run alert are the
guardrails; "do not implement the weaker requester-identity version." Sol:
the run is `shared_unprivileged` by default — no owner memory, no owner
tools, every elevation owner-approved. **Resolved between them:** identity,
delegation, and billing are the owner's (kimix — and Sol agrees the
requester's identity is never used); capability is reduced by default and
owner-private reads/side-effects go through the existing approval machinery
(Sol's substance), keyed **structurally off the surface** rather than a new
`invocationMode` enum — the same key the containment fix uses. A PA that can
act on a colleague's ordinary request without a round-trip, but cannot touch
the owner's private estate without the owner, is what the spec's
"hand my PA a task" plus "respecting privacy/consent" adds up to.

**Stored 3-value `scope` vs 2-value `visibility`.** Both reviewers propose
`scope: global | team | personal` as one column; this doc keeps
`visibility: workspace | private` with global derived from `systemManaged`.
Once the CHECKs both sides propose are in place (`scope='global' ⇔
systemManaged`), the two models are informationally identical and this is a
naming dispute: the substantive convergence — stored, DB-constrained, never
derived from ownership — is adopted. Two values are kept because
`systemManaged` already *is* the stored global bit with its own CHECK and
bootstrap discipline; a third statement of the same fact is a consistency
obligation with no query it improves. If the team disagrees, switching to
the 3-value spelling changes no behaviour in this design.

**A `GlobalAgentDefinition` catalog table with versions/rollback** (Sol)
**vs the existing code-registry `ensure*` pattern** (kimix + this doc).
**Resolved: code registry.** It is the shipped precedent (PA, Librarian,
external products), updates are a deploy, and the policy-merge discipline
already protects per-org grants. A versioned DB catalog is warranted the day
the vendor set is large or org-pinnable — noted as future work, not built.

**Explicit `AgentTeamScope` publication join** (Sol) — declining for now,
consistent with this doc's "no team visibility value yet": today's team
agents are org-visible by channel entitlement and nothing in the spec
narrows them. Sol is right that `Agent.teamId` must not be promoted to an
entitlement source (it is ambient session context); if per-workspace
scoping ever lands, it lands as an explicit join, not as trust in that
column.

**Personal-agent triggers.** Sol: disable in v1 (no safe delivery target).
kimix: allow, owner-only ("a private daily brief" is coherent). **Resolved:
allow, kimix's way**, because the auto-provisioned owner DM *is* the safe
delivery target Sol's review assumed absent, and the run-start assertion
fails closed if anything else is ever targeted.

**Owner deactivation pauses private agents** — kimix and Sol converged on
this independently (against the letter of "ownership is never lifecycle"),
and both derived the same shape: pause + durable alert + existence-only
admin visibility + explicit reactivation. Adopted, with the
people-and-their-agents amendment noted.

## Open questions

1. **Global agent bindability** — recommended above (bindable, read-only
   config), but "auto-bound to #general at provision" is the zero-decision
   alternative; pick one before building.
2. **Presence elevation granularity** — the adjudicated posture routes
   owner-private reads/side-effects through approvals. Should the owner be
   able to pre-grant narrow standing capabilities per channel ("my PA may
   read our shared project docs here without asking each time"), and if so,
   is `ScopeDisclosureGrant` (already on `Agent`) the vehicle? Recommended:
   defer; per-request approval first, measure the friction.
3. **Personal agent deletion** — agent deletion/archival does not exist for
   anyone (the honest register in people-and-their-agents). Private agents
   make the gap more visible (an owner-only object you cannot remove). Does
   archival land with this work or stay deferred?
4. **`visibility` mutability** — private→workspace is a publish act (owner
   only, audited, `agent.visibility_changed`). Is workspace→private allowed
   at all? Both reviewers say scope is immutable-in-v1 / transition must
   atomically strip bindings. Recommended: immutable in v1 (Sol), revisit
   with a dedicated fail-closed transition later.
5. **Presence reactions and the working marker** — the singleton model
   tolerates 👀-marker ambiguity and stamps reactions via the message
   chokepoint; if that proves confusing in rooms with several PAs, the fix
   is the per-user-row conversion, not more columns. Decide after real use.
6. **The 2-value vs 3-value scope spelling** — informationally identical
   once the CHECKs land (see Cross-model review); pick before the migration
   is written, since renaming an enum after the fact is a migration of its
   own.

# Global agents — the Agent Designer's mechanics

The invariants live in [standards/global-agents.md](standards/global-agents.md),
and the map entry in `CLAUDE.md` → "Global agents". This file holds the
mechanics beyond both: what the Agent Designer's tools stand on, how its
capability catalogue is generated, how `agent_handoff` delivers a briefing, and
how the Agent Designer page's sidebar became the same agent rather than a second
one.

Spec and full history:
[plans/2026-09-02-agent-designer-global-agent.md](plans/2026-09-02-agent-designer-global-agent.md).

## Where a global agent can be, and what it can do there

A global agent is **bindable to ordinary channels**, like any other shared
agent. Projects have no separate mechanism: a project's reach *is* its
channels, so putting the Agent Designer in a project's channels is what "add it
to the project" means, and there is deliberately no project-level agent picker
to build. The decision is `docs/plans/2026-08-30-agent-scopes-personal-team-global.md`
open question 1, resolved as recommended there.

**The agent-side refusal is not `systemManaged`.**
`isChannelBindableAgent` (`@nessie/team-admin` `agent-record.ts`) refuses
exactly two agents, each for its own reason:

- the **Personal Assistant**, whose presence is a per-user
  `AgentBinding.principalUserId` row written by
  `POST /api/channels/:channelId/personal-assistant` under its own partial
  unique — a plain binding would be a second, principal-less presence for an
  agent every one of whose runs resolves an owner;
- an **external-agent product** (`executionMode = external_mcp`), which proxies
  every turn to a *per-user* product instance over a DM key its integration
  provisions. A shared room has no such user.

Everything else about the bind is unchanged: `getChannelIfMember`, the private
-agent refusal, `requireOwner` and `checkPolicy('agent', 'bind')` at both the
route and the `agent_bind_channel` PA tool, and — untouched — the **system
channel** refusal. No second agent joins any single-agent system DM, ever: that
surface's sole membership is what makes `effectiveUserId = poster`, the
orchestrator's single-candidate fast path and the private design transcript
safe. `unbindAgentFromChannel` was widened in the same stroke (it filtered
`systemManaged: false`), because removal must be at least as wide as placement
or a placed agent is permanent.

**Placement at run start admits two surfaces, and only one carries identity.**
`assertGlobalAgentRunPlacement` (`worker/src/run/execute/global-agent-placement.ts`):

1. its own home DM, decided by `isGlobalAgentHomeSurface` — the same predicate
   the delegation gate and the identity-tool gate ask, so placement and identity
   cannot disagree about what "its own home" means;
2. an ordinary channel it is genuinely bound to, verified against
   `context.boundAgentIds` (the destination's live `AgentBinding` set, loaded
   once with the run context) rather than the channel's kind, so a stale job
   into a channel it was unbound from still fails closed.

A system channel is never the second arm: reaching that test means the first arm
already said no, so any `systemChannelType` there is somebody else's
single-agent surface. An unknown blueprint slug — one a deploy withdrew — still
runs nowhere at all, bound or not.

**A shared channel is advice-only, and that is the point.** The
`personalAssistantOnly` identity-delegated arm
(`resolveIdentityDelegatedToolIds`) requires the agent's own home DM, so in a
shared channel the Designer has no `agent_create`, `agent_update`,
`agent_bind_channel` or the rest — the tools are *omitted* from its schema, not
offered and denied. `loadGlobalAgentCatalogueBlock` reads that same resolved
toolset and picks the `read_only` closing instruction, which tells it to work
the design out in the room and say where it gets built. `agent_handoff` is
withheld from any `systemSlug` agent (loop bound), so it hands over in words.

**Nothing else in the run path keyed on "system agent" needed widening.**
Memory containment and scope resolution (`execute/memory.ts`), realtime scope
narrowing (`execute/scopes.ts`), reply attribution (`execute/completion.ts`) and
the orchestrator's `isSingleAgentSystemDm` fast path are all keyed on the
*surface* — `systemChannelType` and the home `dmKey`, through
`runDelegatesToRequestingPerson` / `isDelegatedSystemDmChannelType` — never on
`systemManaged`. In an ordinary channel every one of them therefore already
gives a global agent ordinary shared-agent treatment, and engagement there is
the ordinary model-judged decision.

**The stored row stopped claiming `dm_only`.** `surfacePolicy` is the
storage-level statement "this agent lives only in a per-user private DM", so
`ensureGlobalAgent` now writes `shared`; migration
`20260902230000_global_agents_bindable_to_channels` sanctions that fifth tuple
in `agents_system_managed_invariants_chk` and re-states existing rows.
`delegationMode` stays `act_as_requesting_user` and is unchanged in meaning —
*where* that delegation is exercised was always the surface predicate's call.
The admin reads `surfacePolicy` as exactly this question:
`useChannelPlaceableAgents` merges the system tier into the channel pickers and
drops `dm_only` rows, so one sentence serves both sides.

**The admin surfaces.** `GET /api/agents` omits every `systemManaged` row, so
the members popup, the channel roster and the @mention typeahead were all
structurally blind to a global agent — the address-book defect again.
`ChannelsPage` reads `useChannelPlaceableAgents()` instead of `useAgents()`
(the `?scope=all` query the identity directory already holds, so no extra
request), which fixes the picker, the roster and the typeahead together. The
`AvailableAgentRow` / `CurrentAgentRow` clone button is hidden for a global
agent — `cloneAgent` refuses a `systemManaged` source, and a button whose only
outcome is a 404 is worse than none — and a `global` pill names the tier.
Server-side, `message-create.ts`'s pending-invite candidate query dropped its
`systemManaged: false` filter (keeping `agentKind: 'shared'`, which excludes the
PA, and adding an `external_mcp` exclusion), so @mentioning the Designer in a
channel offers the same Invite & reply chip every other agent gets. Portraits
need nothing: `AgentAvatar` already resolves through `AgentIdentityProvider`,
which runs at `scope: 'all'`.

## The model a global agent runs on

Blueprint pin → `NESSIE_DESIGNER_MODEL` → the organisation's default, resolved
once by `resolveGlobalAgentModel` and used by **both** Designer faces, so the
chat agent and the page sidebar can never answer on different models. A
blueprint that pins nothing (the Librarian's cost stance) simply inherits the
organisation's choice.

## The Designer's toolset

The toolset is the blueprint's `identityToolIds`: the five Personal Assistant
provisioning verbs, the three team-structure verbs below, plus
`agent_read`, `agent_update`, `agent_tool_catalog` and `agent_avatar_update` —
`personalAssistantOnly` builtins whose handlers live in
`worker/src/run/pa-tools/agent-config.ts` over shared
`@nessie/team-admin` functions.

Five of them additionally carry **`identityDelegatedOnly`**: `agent_create`,
`agent_read`, `agent_update`, `agent_tool_catalog` and `agent_avatar_update`.
That flag removes the PA's own arm from the `personalAssistantOnly` gate, so
creating and redesigning an agent is the Designer's work alone and the PA hands
the conversation over with `agent_handoff` instead. The tools are not deleted —
the Designer needs them — and they are *omitted* from the PA's schema array
rather than offered and then denied.

- `readAgentRecordForActor` applies exactly the list entitlement
  (`buildAgentEntitlementWhere`, factored out of `listAgentsForUser` so the list
  and the detail read cannot disagree) and answers a `systemManaged` target with
  a **config-only** projection.
- `updateAgentRecord` / `updateAgentAvatar` moved to `agent-update.ts` in
  `@nessie/team-admin` because the worker cannot import
  `api/src/services/*`, so chat inherits the one `canEditAgent` the PUT route
  uses rather than a second copy of it.
- `loadAgentToolCatalog` is a **member-safe** projection (`GET /api/mcp/tools`
  stays organisation-owner-only), assembled field-by-field from a narrow
  selection so no credential, endpoint or grant state can travel in it. It
  names what it cannot grant, with the reason: `explicit_grant`,
  `personal_assistant_only`, or `built_in_specialist_only`.
- `generateAvatarForNewAgent` serves both `POST /api/agents` and
  `agent_create`, and never throws — a failed generation leaves the agent
  faceless rather than failing the creation.

## Standing up a place to work: project → team → channel

A channel hangs off a team and a team off a project, so "give this agent its own
channel" can need all three. Three builtins cover it, all
`personalAssistantOnly` (**not** `identityDelegatedOnly`): provisioning a
container is the same tier as `channel_create`, so the Personal Assistant
reaches them too — `identityDelegatedOnly` stays the narrow marker for the
*design* verbs.

| Tool | Mirrors | Authorization |
| --- | --- | --- |
| `project_list` | `GET /api/projects` (+ `GET /api/teams` for the teams inside) | any active member; owners see every project, everybody else the ones they are a `ProjectMember` of |
| `project_create` | `POST /api/projects` | **organisation owner** (`requireOwner`) |
| `team_create` | `POST /api/teams` | **organisation owner** (`requireOwner`) |

The two writes are owner actions, so they stay **visible** to non-owners and
refuse in words naming who can do it — the `connector_*` precedent, never "I
have no such capability". Role comes from the live `OrganizationMember` row at
call time (`resolveActingMember`), never the run's enqueue-time snapshot.
`project_list` exists for the same reason `agent_list` does: a tool that takes
an id ships with the read that resolves it, and a person hands the Designer
*names*.

There is deliberately **no** project-shaped shortcut inside
`createChannelForUser`. The Designer chains the three calls exactly as a person
chains the three clicks, so `loadChannelTeamProject`'s organisation/hierarchy
check stays the one path a channel is attached through, and creating a team is
an owner's visible act rather than a hidden side effect of asking for a channel.
`project_create`'s own output says so, so the model does not have to infer it.

Shared implementations live in `@nessie/team-admin`
`project-structure.ts` — `createProjectForUser`, `createTeamForUser`,
`listProjectsForUser`, `listTeamsForOrganization`, `listAccessibleProjectIds`,
`isProjectAccessibleToUser`, and the `defaultColumnCreateData` board seeding
that moved out of `api/src/services/board.ts`. The routes call them and
`api/src/lib/request-helpers.ts` wraps the two predicates, so the page and the
tool cannot answer differently. Audit events stay in the routes, which is where
`emitAuditEvent` and the request's `actorContext` live; the tools' own record is
the run's `ToolCall` and the rows themselves.

## Project tickets from the Personal Assistant

`ticket_list`, `ticket_read`, `ticket_board_read`, `ticket_create`,
`ticket_update`, `ticket_assign`, `ticket_move`, `ticket_transition`,
`ticket_iteration_set`, and `ticket_archive_done` are
`personalAssistantOnly`. They mirror the project-board routes through the
shared `@nessie/team-admin` task operations, so a ticket changed in chat has
the same validation, lifecycle event, assignment attention, and board placement
as one changed by clicking.

Every ticket tool is project-scoped. It resolves the acting user's live project
membership before it reads or writes; projectless and merely assigned tickets
are deliberately outside this surface because they have no project disclosure
scope. `ticket_list` resolves ticket IDs, and `ticket_board_read` resolves
column IDs before `ticket_move`; neither model nor caller guesses UUIDs. Ticket
and board reads add that project to the consumed-source basis for non-owners.
Owners read every project through their organisation role, so their own PA does
not acquire an unsatisfied membership-only basis.

There is no hard-delete ticket API. `ticket_transition` to `cancelled` is the
reversible board action, and a cancelled ticket can transition to `inbox` to
restore it. `ticket_archive_done` always takes an explicit project ID and can
archive only that project's completed work; it cannot silently archive another
project's board.

**What a created container contains is one person.** A project, a team and a
channel created this way get exactly one membership row — the requester, as
owner. And a `channel_create` call that names no `visibility` inside a global
agent's home DM (`systemChannelType === 'system_agent'`) lands **private**, not
public: an omitted argument must not publish a room to the whole organisation.
That default is structural — the destination's channel type — and the Personal
Assistant's own `public` default is untouched. The blueprint prompt carries the
rest: confirm a consequential creation as a plain question, say who will be able
to see it, then do the whole thing without re-asking at every step.

## Every path that starts a run in the home DM stamps the member

Admission to those tools is `resolveIdentityDelegatedToolIds`
(`worker/src/run/delegated-identity.ts`), and it requires three structural
facts: an interactive turn, a `user` actor, and
`actionContext.effectiveUserId === actor.actorId`. The third is the one that
gets lost. A single-member delegated system DM — the Personal Assistant's, and
a DM-homed global agent's home — is the only surface where stamping
`effectiveUserId = the poster` is true, and it is true there because the DM
holds exactly one member.

**So every path that starts a run in one of those DMs must stamp it, or the run
silently loses its identity tools.** Nothing throws when it does not: the gate
returns the empty set, the tools are absent from the model's function set, the
capability catalogue renders its `read_only` variant, and the agent truthfully
reports that it cannot create anything. That is exactly what shipped — the
stamp lived inline in `thread-message-create.ts` and was absent from
`POST /api/agent-cards/:cardId/respond`, so a *typed* message worked and a card
press did not, in an agent whose whole interaction style is card-driven.

The rule now lives in two places, in descending order of strength:

- **One chokepoint for the human-turn wake path.** `enqueueOrchestrateDecide`
  (`api/src/queue/pgqueue.ts`) resolves the destination channel itself and
  applies `withDelegatedSystemDmIdentity` (`@nessie/schemas`). A typed message,
  a card press and an invited agent's mention replay all go through it, and so
  does a fourth wake path whose author has never read this section. The
  predicate `isDelegatedSystemDmChannelType` now has one definition, in the same
  module — it previously existed twice, on each side of the process boundary,
  each copy carrying a comment saying the other must not drift.
- **An enumerated list for the run-level enqueues.** `enqueueRunExecution` has
  no equivalent chokepoint: its callers build actor contexts from six different
  provenances, and a blanket stamp there would be a guess about whose identity
  is in play. `api/test/delegated-system-dm-enqueue-sites.test.ts` therefore
  classifies each call site as `stamps`, `inherits` or `unattended`, and fails
  until a new one records a verdict. Resume (both the card and approval paths,
  through `run-resume-core.ts`), continue, restart and the executor launch
  stamp; `deliverGlobalAgentBrief` re-asserts it for both of its callers.

A resumed run is the case worth naming: a `wait: true` card parks its run in
`waiting_input` and the press resumes it from the *parked* run's enqueue-time
actor context, so an unstamped original stayed unstamped through the resume.

## The capability catalogue is generated, never written

`buildGlobalAgentCatalogueBlock` (`@nessie/team-admin`) renders parameters
from the contracts that validate them, tools from `BUILTIN_TOOL_DEFINITIONS`
plus the organisation's live registry rows, and models from the same catalogue
the model picker reads. Hand-written parameter or tool prose is forbidden: a new
tool is in the Designer's knowledge the deploy it ships.

Its `writeSurface` decides the one closing instruction, because the two faces
genuinely differ — `agent_tools` for a run holding the write verbs,
`designer_form` for the sidebar (which must never claim an agent was created,
since the form is unsaved), `read_only` otherwise.

The worker half (`worker/src/run/execute/global-agent-catalogue.ts`) resolves
the blueprint from the run's agent and reads this organisation's catalogues; it
is injected at one `run-job.ts` call site as its own `system` message after the
cache-stable anchor.

## `agent_handoff`

`worker/src/run/pa-tools/agent-handoff.ts` is default-on for every agent,
`{ target: <slug>, brief }`, registry slugs only. The requester is the actor,
never `effectiveUserId`, on an `interactive` run with a live membership re-read;
the loop bound is structural in `authorizeToolCall` (the tool is omitted from
any `systemSlug` agent and from subtask children); `AgentHandoffRequest`
converges repeats under an advisory lock (10-minute cooldown, 60-minute expiry).

Its basis is `computeReplyBasis` then `subtractImpliedScopes` against the
requester's live disclosure viewer, and `run-job.ts` feeds the trigger message's
basis into the run's sink — `loadConversation` excludes `system` rows, so a
hidden brief's restriction would otherwise leave through an empty-basis reply.
The origin doorway renders as `AgentHandoffDoorway`.

## One delivery, two callers

`deliverGlobalAgentBrief` (`@nessie/team-admin`) is the only way a briefing
reaches a global agent's home DM, and every property that makes it safe is a
property of the delivery: a hidden `system` message (never a `role: 'user'` row
written under the person's id, the integration-handoff mistake),
`claimThreadRunOrPend` so a busy DM pends instead of double-running the agent,
`replyPlacement: 'channel'` because a reply threaded under an invisible root
would never appear, and an idempotency key on the enqueue. It takes the two
queue functions as parameters, exactly as `startAgentTodoRun` does: this package
is loaded from its build output by processes that resolve `@nessie/db`
differently.

Callers keep only what is theirs — the metadata shape, the disclosure basis, the
cooldown row and the doorway message.

## The sidebar is the same agent

`POST /api/designer/chat` keeps its own transport (in-process SSE, form-filling
`set_*` / `toggle_tool` calls, ephemeral): it drives the open form
control-by-control, which the DM cannot. What no longer differs is the
definition. `buildDesignerSystemPrompt` renders
`AGENT_DESIGNER_BLUEPRINT.buildSystemPrompt` plus the shared catalogue block,
and the hand-written "expert AI agent designer" persona that used to live there
is gone.

- The service reads `loadAgentToolCatalog` itself. `availableTools` was removed
  from `DesignerChatBodySchema`: the browser must not be the source of what this
  team has, and while it was, the two faces could enumerate different
  tools.
- `web_search` is the Ledger Serper route — `runWebSearch`, moved into
  `@nessie/runtime` so both processes call one implementation, with
  `LEDGER_PROXY_TOKEN` and signed identity headers. The DuckDuckGo HTML scrape
  it replaced predated and violated the Ledger-only rule. A deployment without
  Ledger says so in the prompt and returns no results; there is no fallback.
- The panel renders the Designer's own name and portrait, resolved from
  `AgentRecord.systemSlug` (read-only and server-written) through the identity
  directory — never by matching a display name.
- **Continue in chat** (`POST /api/designer/continue-in-chat`) hands the open
  draft to the person's own Designer DM through `deliverGlobalAgentBrief`, so it
  is the same hidden server-authored briefing a handoff writes.
- New-agent creation presents this same assistant and the existing settings form
  as the **Create** and **Configure** tabs. Create is the default, prompt-first
  route; Configure exposes every setting. Both tabs stay mounted over one typed
  draft, so switching modes never discards the conversation or produces a
  second creation path. Editing an existing agent continues to open directly on
  its settings because there is no creation-method decision to make.

## The detail surface: the ordinary one, disabled

A global agent renders **the same** agent detail page every other agent renders.
Its Edit tab is `AgentDesignerContent` → `AgentDesignerForm` in `readOnly` mode:
the same sections in the same order — avatar, name, role, visibility, model,
reasoning effort, run limits, to-dos, system prompt — with every input, select,
combobox and switch `disabled`, no Save button rendered at all (there is nothing
to save), and no Design Assistant drawer (it exists to fill in a form this reader
cannot submit). A lead-in note at the top of the form says the agent ships with
Nessie and changes only when the deployment is updated.

This replaced a bespoke `SystemAgentConfigPanel` card, deleted 2026-09-02: it was
a second implementation of a view that already existed, re-rendering name, role,
model, effort, limits, prompt and tools in its own layout — the defect Rule zero
#4 names. With it went `GET /api/agents/:agentId/config` and
`readAgentConfigView`, its only consumers. `agent_read` (the Designer's own tool)
still answers configuration for a `systemManaged` agent through
`readAgentRecordForActor`, and `agent_tool_catalog` still describes the reserved
blueprint tools; the admin needs neither, because `GET /api/agents?scope=all`
already returns the whole record — prompt, policy, model, effort, limits — for a
system agent, and the detail page seeds the form from it.

**Which sections a global agent has is structural, stated once** in
`AgentDetailTabs` (`SYSTEM_AGENT_TABS`): Edit and Tools, and nothing else.
`isAgentAccessibleToActor` is deliberately untouched, so status, activity,
sub-agents, messages, to-dos, documents, the mailbox and the cloud browser all
404 on a system agent — a global agent's activity spans every member's private
DM and must stay closed. Those tabs are not rendered and their reads are not
issued. The Tools tab is `AgentAvailableTools`, which already resolves to its
read-only `ToolPicker` for an agent the viewer cannot edit — the same catalogue,
the same search, the switches disabled.

## Addressable, not bound — the "New message" address book

The Direct-messages list shows *conversations*: a row appears once its channel
carries a message. The address book behind **New message** answers the opposite
question — everything you can start a conversation with — so every agent a
person may talk to belongs in it, the Agent Designer and the Personal Assistant
included, whether or not they have written to it yet.

A DM-homed system agent is never *bound* into a new conversation:
`bindAgentToChannel` refuses every `systemManaged` agent and every system
channel, and a system DM holds exactly one member by database constraint. It
already owns one home DM per person, so addressing it **resolves** to that
channel.

- **One predicate, both sides.** `isDmAddressableSystemAgent`
  (`@nessie/team-admin`) is true for the Personal Assistant and for any
  global agent whose blueprint homes it `per_user_dm`. `mapAgentRecord` emits it
  as `AgentRecord.dmAddressable` — present only when true — and the picker
  (`admin/src/lib/channel-compose-recipients.ts`) offers exactly the rows
  carrying it, so no client hand-names a slug and the picker cannot offer an
  option the route would refuse. It reads `GET /api/agents?scope=all`: the
  default list excludes every `systemManaged` row, which is why no global agent
  and no Personal Assistant could ever appear in that address book.
- **The server branch is structural and member-level.**
  `POST /api/channels/conversations` calls `resolveSystemAgentConversation`,
  which ensures the home through the one provisioning path each agent already
  owns (`openGlobalAgentHome` → `ensureGlobalAgentBootstrap`, or
  `ensurePersonalAssistantBootstrap` — never a second provisioner) and returns
  that channel with its `defaultThreadId`. No owner gate: that gate exists
  because binding an arbitrary agent into a new conversation is *placement*, and
  opening your own pre-provisioned home DM is not placement at all. It stands
  unchanged for every other agent recipient, which still reaches
  `requireOwner` + `findOrCreatePrivateConversationChannel`.
- **Combining one with anybody else is refused in words**
  (`SYSTEM_AGENT_CONVERSATION_EXCLUSIVE`), never half-honoured: there is no
  shape of channel that could hold it.

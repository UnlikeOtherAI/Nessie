# Personal-assistant tools and route mirroring

Authoritative standard, moved verbatim out of [`AGENTS.md`](../../AGENTS.md)
so it is read when the work touches this area rather than loaded into every
session. `AGENTS.md` carries the one-line invariant and points here; **this
file is the rule**.

- **A personal-assistant tool that does what a person does by clicking calls
  the same function that person's button calls, and mirrors that route's
  authorization exactly — no weaker, no stronger.** The provisioning builtins in
  `worker/src/run/pa-tools/provisioning.ts` and `worker/src/run/pa-tools/team-structure.ts`
  are the pattern: `agent_list` and `channel_create` (`provisioning.ts`) and
  `project_list` (`team-structure.ts`) are member-level because their routes
  carry only `requireActorContext`, while `project_create` and `team_create`
  (also `team-structure.ts`) are organisation-owner because `POST /api/projects`
  and `POST /api/teams` carry `requireOwner`; binding reproduces all four gates of
  `POST /api/agents/:agentId/bindings` (channel membership, the system-channel
  refusal, owner, `checkPolicy('agent','bind')`); trigger creation parses the
  route's own `CreateAgentTriggerBodySchema` and refuses a schedule with no UOA
  identity on a signing deployment. Because `api/src/services/*` is unreachable
  from the worker, the shared functions live in **`@nessie/team-admin`**
  and the api services re-export them — never a second copy in `pa-tools`.
  `pa-tools/channels.ts` carried a "mirrored from api/src/services" comment over
  a duplicated `canManageChannel` for exactly that reason; on 2026-08-29 the
  predicate and the writes it gates moved to `channel-manage.ts`, which the api
  service re-exports and the PA tool imports. The predicate is now
  `canModifyChannel` in `resource-authority.ts`, beside `canModifyProject`. An owner-gated tool stays visible
  to non-owners and refuses in words, following `pa-tools/connectors.ts`. Role
  comes from the live `OrganizationMember` row at call time, not from the run's
  enqueue-time `actorContext`. **A tool that takes an id ships with the read
  that resolves it**: in the UI the owner picks the agent from a list, so
  `agent_list` (→ `listAgentsForUser`, `GET /api/agents`'s own entitlement
  scoping) is what makes `agent_bind_channel` / `agent_trigger_create` usable on
  an agent the user merely named. Details: `CLAUDE.md` → "Personal assistant —
  team provisioning".
- **Provider-linked call tools use this same route-mirroring pattern.**
  `meeting_link_create` and `call_start` are separate PA-only builtin ids:
  minting a provider link and ringing a channel have different blast radii, and
  only separate ids can later put `call_start` behind an explicit grant. They
  intentionally require no explicit grant today because a person's PA is their
  delegate. Both re-read the live acting membership and call
  `createCallLinkForTeamUser` / `startCallForUser` in
  `@nessie/team-admin`; never duplicate their gates. `call_start` leaves
  `expectedOrganizationId` unset so the shared start seam resolves the
  **target channel's** organisation and re-checks membership there, preserving
  the route's indistinguishable `Channel not found` refusal across UOA orgs.
  `meeting_link_create` names a team rather than a channel, so it passes the
  run's own tenant (`resolveActingMember`'s `organizationId`) as
  `createCallLinkForTeamUser`'s required `organizationId` with
  `entitlement: 'team_member'`, exactly as `POST /api/meetings/links` passes
  the session's tenant; a team outside that organisation is the same
  indistinguishable `Team not found`.
  An unattended run has no requesting user and must refuse before minting.
- **An ordinary agent reaches the act-as-user setup verbs through one explicit
  grant, `project_operator`, and only for the live person talking to it.** The
  `personalAssistantOnly` gate in `worker/src/run/tool-policy.ts` has a third
  arm beside the Personal Assistant's and a global agent's identity arm: a
  definition flagged `projectOperator`, on a run
  `resolveRunProjectOperatorToolIds` admitted. Everything that makes it safe is
  structural and is stated in "The project-operator capability" below; the
  rule to keep is that the grant widens *who may ask*, never *what the asker
  may do* — every verb mirrors its route as the person asking.

## The project-operator capability

Asked for in the ticket-driven agents plan
([setup-and-ui.md](../plans/2026-09-23-ticket-driven-agents/setup-and-ui.md) →
"The project-operator capability (T6)"): a CTO, or any agent its owner chooses,
sets up new projects and flows for the person talking to it.

- **One grant, a registry entry that is not a tool.** `project_operator`
  (`packages/runtime/src/builtin-project-operator-tools.ts`) is in
  `CAPABILITY_GRANT_DEFINITIONS`, which `SYSTEM_TOOL_DEFINITIONS` includes and
  `BUILTIN_TOOL_DEFINITIONS` does not. So it is seeded in every organisation's
  tool registry, protected from generic policy writes like every
  `requiresExplicitGrant` key, listed on the agent's Tools page and by
  `agent_tool_access_inspect` (with what it lets the agent do), and written only
  by the one explicit-grant writer — the owner's protected Tools switch or the
  Designer's `agent_tool_access_set` — while no run is ever offered it as a
  function. An owner who switches its registry row off switches the arm off for
  the organisation.
- **The arm opens only on a live person's own turn**
  (`worker/src/run/project-operator-admission.ts`). One loader
  (`loadProjectOperatorFacts`) and one verdict (`projectOperatorRefusal`) serve
  run setup and every call alike, so a verb is never offered by one answer and
  refused by another. The verdict needs all of:
  - the grant `true` and the capability not switched off;
  - a live, ordinary channel of a real project — standard type, not archived,
    no system type, no DM key, and not an organisation-wide channel (its
    project is the invisible `channelRoot` container, which no one is in) —
    that the agent is bound to;
  - an ordinary shared agent (not the PA, not system-managed or a global
    agent, not a spawned child), a user actor on an interactive turn, **no
    action purpose at all**, and `effectiveUserId` absent or the actor.
    "No purpose" is an allow-list: `ticket.work`, peer delegation,
    channel-policy work, briefs and deliveries all carry one;
  - **the person's own turn** (`isPersonsOwnTurn`): the job's message is the
    run row's own trigger, and it and every message a drain folded in is a
    `user` message by the actor, in this conversation, not deleted, with the
    composer's person-authorship marker; and a run that replays another — a
    Continue, a card or approval resume, a Restart — names its presser
    (`resumedByUserId`, which `restartRun` now stamps as well) and that presser
    is the actor. "User actor + interactive" alone was not enough: Restart and
    Continue put the presser in as the actor and replay the original kickoff,
    a card resumes as the parked run's actor whoever answered, and a drain
    takes its latest person's actor while folding in others' messages. These
    are the executor conversation lease's own checks
    (`executor-lease-carry.ts`), mirrored.

  Trigger fires, schedules, worker checkpoint continuations, relayed posts and
  sub-agents never qualify. The verbs are resolved once at run setup and
  handed to both `resolveAgentTools` and `authorizeToolCall`, like the identity
  arm. On this arm the grant also stands for a verb's own explicit allow
  (`ticket_board_create`), on no other arm.
- **Every handler re-checks the arm** (`worker/src/run/pa-tools/project-operator.ts`).
  `actingFaceOf` reads the face from structural facts — the PA's kind, a
  global agent's own row in its `system_agent` home, or else the operator's —
  and on the operator face `assertProjectOperatorCall` re-runs the same loader
  and verdict before the verb resolves its acting member. A call off the
  person's own turn is refused with a sentence telling the agent to say what it
  finished and ask the person to repeat the request
  (`PROJECT_OPERATOR_LIVE_TURN_REFUSAL`) — a long setup turn that the worker
  continues after a checkpoint loses the arm midway, and the gate says the same
  (`liveTurnDenialMessage`). Every other refusal is one sentence naming no
  condition.
- **Standing work needs a live turn on every arm.** A definition flagged
  `requiresLiveRequester` — the workflow writes and the verbs this capability
  added (`ticket_board_column_create`/`_update`, `kb_space_create`) — is denied
  by the gate (`live_requester_required`) unless the run is a user actor's
  interactive turn, whichever arm admitted it. The Personal Assistant's arm is
  the one it matters for: it also opens on the schedules the PA fires for its
  owner, so a PA `schedule_task` fire can no longer install a workflow, arm a
  trigger, make a space or reshape a board as its owner with nobody there. Its
  handlers re-check it (`resolveOperatorAwareMember(context, toolId)`). The
  PA-only verbs this capability did not add keep the PA's arm as it was.
- **The verbs** (`PROJECT_OPERATOR_TOOL_IDS`), each the route's own function as
  the person asking: `project_list`, `project_structure_read` (what the person
  can see of a project: boards with their columns by id, channels, spaces),
  `project_create` (it answers with the board the project starts with, column
  by column, so the operator renames and recategorises that board rather than
  making a second), `team_create` (owner), `channel_create` (**protected** when
  no visibility is named), `ticket_board_create` (answers with its columns) and
  `ticket_label_create` (in this channel's project, or a project named that the
  person can change — `canModifyProject`; the lend of either keeps the
  channel's project), `ticket_board_column_create` and
  `ticket_board_column_update` (`requireProjectModifier`), `kb_space_create` (a
  project member, `knowledge_space:create`; Project Documents through its
  idempotent provisioning, or a named project space; audited `kb.space.created`
  as the route audits it), `agent_trigger_create` and `agent_trigger_update`
  (owner, and on this face only for itself or an agent in one of this
  project's channels, working in this project; refusals name the field), and
  the workflow writes `workflow_create`, `_update`, `_install`,
  `_trigger_create` and `_run`. **Project membership is not in the set**, nor
  is binding an agent to a channel: either would widen who can start work.
- **Workflow authoring moved behind it.** The workflow writes carried no flag,
  so every shared agent could author, install, arm (webhook, event, cron) and
  start workflows as the speaking owner, and on a scheduled fire as the creator
  it reconstructed. They are `personalAssistantOnly` + `projectOperator` +
  `requiresLiveRequester` now; the PA and the Designer keep them on their own
  arms, on live turns. `workflow_list`, `workflow_preview` and
  `workflow_run_status` stay ordinary: a list of names an owner may read, a card
  that re-reads the workflow under each viewer's own access, and a status-only
  read — none creates, arms or starts anything. Migration
  `20260924120100_project_operator_workflow_grants` grants `project_operator`
  to every live, top-level, ordinary agent whose policy named one of the five
  `true` (an agent that only had them by default is granted nothing; a spawned
  child is left alone). **Access narrows**: the grant keeps them only on a
  person's own turn in a project channel the agent is in, and loses them on
  its scheduled, interval, webhook and event fires, in a DM and on a peer
  delegation — while opening project, team, channel, board, space and trigger
  setup too. One `WARNING` names each agent granted and says both; a second
  names each whose use narrows today (an enabled unattended trigger, or no
  project channel at all). `createWorkflowTrigger` records its creator
  (`config.authorUserId`, authorship only), from the route and the tool.
- **Disclosure.** Every operator write names something a wider audience reads,
  so a private-conversation source closes them all
  (`blocksPrivateConversationWrite`'s `operatorVerb`), and board, column, label
  and space writes pass `assertProjectWriteDestination` for their project. An
  operator run recalls memory under project-write containment, as a lent write
  does.
- **Machine access stays the machines' owner's.** A `ticket_changed` trigger
  the operator creates answers "Machine access: not set up" and raises a
  `trigger_machine_access` bell item for the person it acted for
  (`raiseTriggerMachineAccessAttention`), worded so it is true before the
  trigger page has its Machine access section: "<trigger> needs machine access:
  ask the machines' owner to set it up, from the trigger's page or the Agent
  Designer", opening the trigger's page. It surfaces while the trigger's agent
  is live, no standing policy for it is `preparing` or `live`
  (`executor_standing_policies`), and the recipient is still an organisation
  owner; it is written with no push and no realtime frame, which is why it
  ships in the deploy that adds the kind. T4 links the section.

Pinned by `worker/src/run/project-operator-admission.test.ts` (the predicates,
the verdict, the set, the gate and the live-turn flag),
`worker/test/db/project-operator.test.ts` (every refused shape through the real
loader, at run setup and at the call: fires, schedules, continuations, ticket
work, Restart and Continue of somebody else's or a trigger's input, a card
somebody else answered, a mixed drain, a relayed post, an unbound room, an
organisation-wide channel, a DM, a system conversation, an archived room, the
switch and the grant), `worker/test/db/project-operator-verbs.test.ts` (each
verb as the requester and refused beyond their rights, the Mobile board set up
from the one it starts with, the trigger scope and the attention item),
`worker/test/workflow-authoring-regression.test.ts` (a PA schedule starts no
workflow), `api/test/project-operator-workflow-grants-migration-postgres.test.ts`
and `admin/test/alert-row-trigger-machine-access.test.ts`; the Tools page entry
is screenshotted by `admin/e2e/tool-access-ui-proof`.

## Detail

Moved verbatim out of [`CLAUDE.md`](../../CLAUDE.md) → "Personal assistant — team provisioning".


Seven `personalAssistantOnly` builtins reach the PA
(`worker/src/run/pa-tools/provisioning.ts` and `team-structure.ts`), each
mirroring one REST route's
authorization — no weaker, no stronger — and calling the same service function
the route calls. The pattern, visible-refusal for owner-gated tools, the
tool-ships-with-its-resolving-read rule, and the one arm that also opens them to
a global agent on its own home DM are in the invariants above.
Per-tool facts:

- `agent_list` → `listAgentsForUser` (`safe: true`). Any active member, matching
  `GET /api/agents` and scoped by the same entitlement the Agents page uses —
  never narrowed by the session's project/team. It exists because
  `agent_bind_channel` and `agent_trigger_create` take an `agentId` an owner
  would pick from a list. Output is name, role, `agentId` and bound channels;
  the read stamps the sink (private agents, and non-public bound channels).
- `channel_create` → `createChannelForUser`. Any active member, matching `POST
  /api/channels`. The team defaults from the run context: explicit `teamId`,
  else the session tenant/action team, else the team of the channel the
  conversation is in — never an invented default.
- `agent_create` is in this file but **not reachable from the PA** — it carries
  `identityDelegatedOnly`, so only the Agent Designer calls it (above), and the
  PA hands the conversation over with `agent_handoff`. It maps to
  `assertLedgerAgentModelSelection` + `createAgentRecord`, is member-level like
  `POST /api/agents`, accepts optional `visibility`, and exposes no
  `agentKind`/`systemManaged`/`surfacePolicy`/`delegationMode`/`parentAgentId`;
  private creation stamps the acting member as owner and atomically provisions
  the owner-only home DM. `assertGenericAgentToolPolicyInput` refuses every
  `requiresExplicitGrant` key and DeepWater marker, so chat cannot grant itself
  research.
- `agent_conversations_list` → `listAgentConversationsForUser` (`safe: true`),
  mirroring `GET /api/agents/:agentId/conversations`, and
  `agent_conversation_start` → `startAgentConversation`, mirroring
  `POST` on the same path — both in
  `packages/team-admin/src/agent-conversations.ts`, both member-level, both
  scoped as the acting member. The list is to a thread id what `agent_list` is
  to an agent id, so `conversation_reference` never has to guess one. The start
  door writes only the `Thread`; the opening message goes through the **agent**
  door (`createAgentMessage`) rather than the person's, because the assistant is
  the one speaking, with the delegated-post basis
  (`computeDelegatedPostBasis` — the requester's own scopes are subtracted only
  when the destination's whole audience *is* the requester), and it claims the
  target's run in the same transaction as the doorway message it writes back
  into the origin thread. It is deliberately allowed on unattended runs: a
  scheduled "every morning, ask the researcher to…" is the point.
- `agent_bind_channel` → `bindAgentToChannel`. Reproduces all four gates of
  `POST /api/agents/:agentId/bindings`: channel membership
  (`getChannelIfMember`), the system-channel refusal (any non-null
  `systemChannelType`), owner, and `checkPolicy(…, 'agent', 'bind', …)`.
- `agent_trigger_create` → `createAgentTrigger`, parsing the route's own
  `CreateAgentTriggerBodySchema`; scheduled/interval triggers build
  `launchOrigin` from the acting user and carry `actionContext.uoaIdentity`, and
  a signing deployment refuses a schedule without it, as the route does. Every
  type records the acting user as its `authorUserId`, which grants nothing. Its
  `type` enum and config prose are generated from the typed trigger config
  union (`AgentTriggerConfigInputSchema`), and a `ticket_changed` refusal
  (`TriggerConfigRefusalError`) reaches the model field by field, as the route
  answers it (`TRIGGER_CONFIG_REFUSED`); the other types keep the generic
  sentence ([ticket-work.md](ticket-work.md)).
- `agent_avatar_generate` (also `identityDelegatedOnly`, so the Designer's
  alone) → `generateAgentAvatar` + `updateAgentAvatar`, mirroring
  `POST /api/agents/:agentId/avatar/generate` in its exact order — the
  accessibility read first, then `assertAgentEditAuthority`, and only then the
  billed Ledger call — followed by the confirming `PATCH …/avatar`. It runs both
  halves because a conversation has no preview to accept, and its refusals are
  therefore its route's: a `systemManaged` agent is `Agent not found` here, not
  the "managed by Nessie itself" wording `agent_avatar_update` gives from
  `canEditAgent`. Mirroring the route is the rule; matching a sibling tool's
  phrasing is not. A named `style` is remembered through the settings cascade
  (`agentAvatar.style`, see [scoped-settings.md](scoped-settings.md)) and a
  locked house style refuses that write exactly as `PUT /api/settings` would;
  `instructions` describe one portrait and are never stored.

Three more (`worker/src/run/pa-tools/team-structure.ts`) cover the
containers a channel needs — a channel hangs off a team, a team off a project.
(That is the schema's current, inverted shape. The model is
Organisation → Team → Project → Channel; see
[team-model.md](team-model.md). These tools describe the code as it
is, so they are left as-is until the foreign key is flipped.)

- `project_list` → `listProjectsForUser` + `listTeamsForOrganization`. Any
  active member, matching `GET /api/projects` (owners see every project in the
  organisation, everybody else the ones they are a `ProjectMember` of) with
  each project's non-system teams nested, narrowed to those projects — strictly
  narrower than `GET /api/teams`'s own organisation scope. It is the read that
  makes `team_create`'s `projectId` and `channel_create`'s `teamId` usable on a
  project the person merely named. It stamps `project:` scopes only on the
  membership arm: an owner reads by role, so stamping would compute a basis the
  requesting owner does not satisfy (the `recordVisibleAgentRead` reasoning).
- `project_create` → `createProjectForUser`. **Organisation owner**, matching
  `POST /api/projects`; carries that route's single owner-membership row and
  default board columns.
- `team_create` → `createTeamForUser`. **Organisation owner**, matching `POST
  /api/teams`; a `projectId` outside the organisation gets the route's own
  indistinguishable "not found".

There is deliberately no project-shaped shortcut inside `createChannelForUser`:
project → team → channel is three calls, exactly as it is three clicks, so
`loadChannelTeamProject` stays the one path a channel is attached through. A
`channel_create` call naming no `visibility` inside a global agent's home DM
(`systemChannelType === 'system_agent'`) lands **private** — an omitted argument
must not publish a room to the organisation; the PA's own `public` default is
unchanged.

Owner-gated tools stay **visible** to non-owners and refuse in words (the
`connector_*` precedent). Role is re-read from the live `OrganizationMember` row
at call time (`resolveActingMember`), because a run's `actorContext` is an
enqueue-time snapshot while the API re-resolves per request; a deactivated
membership is refused. Deliberately **not** included: agent creation or
redesign (the Designer's, above), agent delete, policy-target mutation, or
anything touching the DeepWater bundle. `schedule_task` remains the un-gated "schedule *me*"
tool; `agent_trigger_create` is the owner action on *another* agent.

Who may **edit** an agent is its ownership state, not the organisation owner
role: private ⇒ the live owner alone, person-owned ⇒ the live owner plus org
owners, team-owned (`ownerUserId` null) ⇒ anyone entitled plus org owners,
`systemManaged` ⇒ nobody. Ownership transitions and `todosEnabled` keep their
own narrower gates. Full rule:
[docs/standards/agent-ownership.md](agent-ownership.md);
predicate: `@nessie/team-admin` `agent-edit-authority.ts`, mirrored for
affordances by `admin/src/components/features/agents/agent-edit-authority.ts`.

Private-agent transfer is deliberately unsupported: the owner-only home DM
encodes the steward, so an `ownerUserId` change is refused with
`AGENT_PRIVATE_TRANSFER_UNSUPPORTED` until the agent is published. When a
private owner is deactivated, the owner-only Members surface receives only the
aggregate count from `GET /api/agents/paused-private-count` — never rows or
names.

Private creation is one transaction: the agent, its
`agent:{org}:{owner}:{agent}` private DM, the sole owner membership, default
thread, and direct home binding either all commit or none do. Database
constraints independently refuse a second home member, a malformed `agent:` DM,
or a private-agent binding to any other channel. The worker re-checks the loaded
destination before inference and permits only that home DM or the agent's own
trigger thread. Owner deactivation disables only private-agent triggers in the
membership transaction, records one aggregate audit transition with no widened
recipient, and does not auto-resume on reactivation.

**Reuse, never fork.** `api/src/services/*` cannot be imported by the worker, so
the shared functions live in **`@nessie/team-admin`** (mirroring how
`@nessie/mcp-manage` is shared) and the api services re-export them, leaving the
routes untouched: channel create/records/slugs, agent create/list/record/
bindings and the tool-policy protected-key gate, trigger
create/core/config-identity, the Ledger agent-model catalogue, `checkPolicy`,
and the `getChannelIfMember` / `isAgentAccessibleToActor` predicates. The
records those functions return (`ChannelRecord`, `AgentRecord`,
`AgentTriggerRecord`, `CreateAgentTriggerBody`) moved to `@nessie/schemas` for
the same reason; `api/src/contracts` re-exports them.

## Saved browser accounts and model plans

`account_connections_list` is a metadata-only read for the Personal Assistant
and Agent Designer on a live person's turn. It calls the same Browserbase
directory as Settings and `listUserSubscriptions` with inactive plans included,
so a broken connection is reported as needing attention rather than missing.
The directory rechecks UOA entitlement, includes permitted team accounts, and
never reads a key or key reference. The tool records the requesting user's
disclosure scope even for an empty inventory. Each source can fail independently;
failed reads mean unknown and never an empty list.

Both assistants check this inventory before requesting a key or claiming that
Browserbase or Kimi is not linked. They acknowledge existing connections and
offer access for the named agent. An accepted design already authorizes its
listed tool grants. The Designer uses its existing protected grant verbs; the
Personal Assistant offers the existing Designer handoff. A Personal Assistant
is an editable protected-tool target, although its general configuration and
model remain managed by Nessie. Global specialists such as Agent Designer
retain their fixed toolsets. Connection discovery grants nothing and does not
change browser scope or model billing.

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
  service re-exports and the PA tool imports. An owner-gated tool stays visible
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
  `@nessie/team-admin`; never duplicate their gates. A call tool leaves
  `expectedOrganizationId` unset so the shared start seam resolves the
  **target channel's** organisation and re-checks membership there, preserving
  the route's indistinguishable `Channel not found` refusal across UOA orgs.
  An unattended run has no requesting user and must refuse before minting.

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
- `agent_bind_channel` → `bindAgentToChannel`. Reproduces all four gates of
  `POST /api/agents/:agentId/bindings`: channel membership
  (`getChannelIfMember`), the system-channel refusal (any non-null
  `systemChannelType`), owner, and `checkPolicy(…, 'agent', 'bind', …)`.
- `agent_trigger_create` → `createAgentTrigger`, parsing the route's own
  `CreateAgentTriggerBodySchema`; scheduled/interval triggers build
  `launchOrigin` from the acting user and carry `actionContext.uoaIdentity`, and
  a signing deployment refuses a schedule without it, as the route does.

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

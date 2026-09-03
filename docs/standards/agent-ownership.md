# Agent ownership, visibility and edit authority

Authoritative standard, moved verbatim out of [`AGENTS.md`](../../AGENTS.md)
so it is read when the work touches this area rather than loaded into every
session. `AGENTS.md` carries the one-line invariant and points here; **this
file is the rule**.

- **An agent belongs to a person, and the org tree is a read-time JOIN — never
  a stored hierarchy.** `Agent.ownerUserId` (stewardship: their "virtual
  employee") is the only local fact behind it; people, roles, teams and
  lifecycle come from UOA live on every read. There is deliberately **no human
  reporting edge**: UOA's roster carries no manager field, and an edge that
  decided authority would be the second org hierarchy the SSO invariant forbids
  whatever table it sat in. Tenancy is enforced in the database — a composite FK
  `(organization_id, owner_user_id) → organization_members`, because
  `spawn_subtask` writes agents outside the `createAgentRecord` chokepoint, with
  `ON DELETE NO ACTION` since on a composite key `SET NULL` blanks *every*
  referencing column including `organization_id`; a CHECK keeps ownership off
  system-managed and org-less agents (the PA is one org-singleton row serving
  everyone). The FK proves the membership row *exists*, never that it is live:
  deactivated rows are retained deliberately, so **every read re-derives
  `deactivatedAt: null`**. One predicate, `buildVisibleAgentWhere`, is shared by
  `listAgentsForUser`, `isAgentVisibleToUser`, and every access rule that derives
  a human audience from an agent, so list, detail, and derived access cannot
  disagree. Its stewardship arm's conditions are load-bearing — the live-membership
  join (the branch widens by pointer equality, so without it a deactivated
  member keeps seeing their agents) and `parentAgentId: null` (else owning one
  agent pours every unreaped `spawn_subtask` child into that list forever).
  `Agent.visibility = private` is the deliberate exception to org-owner
  omniscience: every entitled agent read composes `buildAgentVisibilityWhere`,
  and only the private agent's live owner passes its private arm — an org owner
  never sees another person's private agent. Subtask children inherit both
  owner and visibility so delegated private work cannot mint team-visible
  rows. A private agent is created atomically with its exact owner-only
  `agent:{org}:{owner}:{agent}` home DM, and the worker refuses any run outside
  that home or the agent's own trigger thread before inference. Deactivating its
  owner pauses only its triggers and records one aggregate audit transition;
  the owner-only Members surface receives the count through
  `GET /api/agents/paused-private-count` and never private rows or names;
  team agents keep running, no private detail is widened, and reactivation
  never resumes automation implicitly.
  `loadAgentChildren` takes the viewer's scope for the same reason. Never
  backfill ownership: nothing recorded who created an agent, so old rows read
  `Unowned` and `agent.created`/`agent.owner_changed` now emit instead. The tree
  itself is one `buildPeopleAgentsTree` rendered on `/settings/members` with the
  people source parameterised (UOA roster, or local `User` rows on a no-IdP
  install) — *unowned* and *owned outside this team* stay separate buckets,
  because the roster is team-keyed and a colleague on another team is otherwise
  indistinguishable from someone who left. `resolveLocalUserIdsByUoaSub` is
  org-scoped: `User.uoaSub` is globally unique, so the naive lookup hands this
  organisation a principal id for a stranger. Spec:
  `docs/plans/2026-08-29-people-and-their-agents.md`.
- **Ownership decides who may edit, and "edit" is field-sensitive.** Every
  agent-mutation route gated on the ORGANISATION owner role, so no ordinary
  member could edit any agent — not even the private one they own. It never
  surfaced because the people editing were org owners. `canEditAgent` /
  `assertAgentFieldAuthority` (`@nessie/team-admin`
  `agent-edit-authority.ts`) replace `requireOwner` at `PUT /api/agents/:id` and
  both avatar routes, and are the one rule chat tools consume too, so routes and
  the Agent Designer cannot disagree. A **private** agent is its live owner's
  alone (an org owner cannot see it, so cannot edit it); a **person-owned**
  team agent takes its live owner plus org owners (without that override a
  deactivated steward leaves an agent with no editor); a **team-owned** agent —
  `ownerUserId` null — takes anyone entitled to it, plus org owners; a
  `systemManaged` agent takes nobody, refused **in the service**
  (`SYSTEM_AGENT_IMMUTABLE`) rather than only hidden by route invisibility.
  Owner-ness is re-derived from the live `OrganizationMember` row on every call,
  never the session claim or an enqueue-time snapshot. A null owner is a
  **deliberate state**, not missing history: "team-owned" means any member who
  can see the agent may rewrite its prompt, model, tools and limits, while
  *placement* (`agent_bind_channel`) keeps its stricter four gates — editing
  improves the shared agent in place, binding changes who is exposed to it. One
  predicate over the whole PUT body would be wrong, because that body also
  carries `ownerUserId` and `todosEnabled`: ownership transitions belong to the
  current owner or an org owner (so *claiming* a team-owned agent is
  org-owner-only by construction) and `todosEnabled` keeps its own org-owner
  gate — both firing only on an actual change, so a form echoing the stored
  value back stays an ordinary edit. Unchanged by all of it:
  protected/explicit-grant policy keys (`assertGenericAgentToolPolicyInput` is
  the law for every editor), immutable `visibility`,
  `AGENT_PRIVATE_TRANSFER_UNSUPPORTED`, and the `agent.owner_changed` audit on
  both transfer and release. Details:
  `docs/plans/2026-08-29-people-and-their-agents.md`; decision:
  `docs/plans/2026-09-02-agent-designer-global-agent.md` → "Edit authority".

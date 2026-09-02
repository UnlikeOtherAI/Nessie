# Global agents, specialist delegation and agent_handoff

Authoritative standard, moved verbatim out of [`AGENTS.md`](../../AGENTS.md)
so it is read when the work touches this area rather than loaded into every
session. `AGENTS.md` carries the one-line invariant and points here; **this
file is the rule**.

- **A global agent is a blueprint in code, one row per organisation, and a
  single-agent DM.** App-provided agents (the Agent Designer is the first) live
  in a registry in `@nessie/workspace-admin`; `ensureGlobalAgent` instantiates
  each as one `systemManaged` row per organisation, keyed by `Agent.systemSlug` —
  unique on `(organizationId, systemSlug)` with a CHECK requiring `systemManaged`
  AND a non-null `organizationId`, so a cross-org vendor row is a database
  impossibility and a display name is never again the discriminator. The ensure function is
  `ensurePersonalAssistantAgent` verbatim in shape, with tool policy merged
  under `acquireAgentToolPolicyLock` *after re-reading the row* so a targeted
  grant committed in between survives, and the blueprint's own policy passes
  `assertGenericAgentToolPolicyInput` like user input: vendor config is not
  authority. Its home is a per-user private DM keyed
  `gagent:{slug}:{orgId}:{userId}`, admitted by the channel-surface CHECK under
  its own `system_agent` type (never a widened pattern — the `extagent:` lesson)
  and held to exactly its encoded member (owner at **segment 4**) by the deferred
  home-membership trigger. Sole membership is what makes `effectiveUserId =
  poster` and the single-candidate fast path safe, so it must hold at rest. Three
  refusals keep it true: no agent binds into ANY system channel
  (`bindAgentToChannel`, both routes, the PA tool; `canManageChannel` likewise
  refuses rename, archive and re-membering), `createAgentTrigger` refuses a
  `systemSlug` target (a scheduled run re-arms its creator's identity), and
  `assertGlobalAgentRunPlacement` admits only the home DM before any inference. Reachability is the point of the tier: `listAgentsForUser`'s
  `includeSystemManaged` arm is `{ organizationId, systemManaged: true }` and no
  longer channel-gated: an app-provided agent nobody can find is the
  unreachable-capability defect Rule zero names. Finding one has to lead
  somewhere, so it renders **the ordinary detail surface with every control
  disabled** — the same designer form, filtered to Edit + Tools — never a second
  read-only view beside it, while `isAgentAccessibleToActor` stays untouched:
  status, activity, messages and children still 404, a global agent's activity
  spanning every member's private DM. `docs/global-agents.md`; spec:
  `docs/plans/2026-09-02-agent-designer-global-agent.md`.
- **A capability can be moved to a specialist without being deleted.**
  `BuiltinToolDefinition.identityDelegatedOnly` narrows `personalAssistantOnly`
  to the identity-delegated arm alone — `agent_create`, `agent_read`,
  `agent_update`, `agent_tool_catalog`, `agent_avatar_update` are reachable only
  by a blueprint that declares them, in its own home DM, on an interactive human
  turn. Not even a Personal Assistant: it keeps the operational verbs on existing
  agents and hands over with `agent_handoff`, the design catalogue being large
  and belonging in one agent's context. A flag that removes an arm — the tool
  *omitted* from the PA's schema, not offered and denied — is the honest
  mechanism; deleting it would take it from the specialist too.
- **"This run delegates to its requesting person" is ONE predicate, and the
  identity-tool gate widens by exactly one arm.** The worker keyed delegation on
  `agentKind === 'personal_assistant'` in five places — memory scopes, realtime
  narrowing, reply attribution, the trigger binding waiver, the acting-member
  helpers — because the PA was the only delegate. A global agent is
  `agentKind: 'shared'` and delegates as completely, so all five would have
  treated it as ordinary with no failing check anywhere.
  `runDelegatesToRequestingPerson` (`worker/src/run/delegated-identity.ts`) is
  the one answer: the PA in its own DM, or a `home: 'per_user_dm'` blueprint in
  its own home DM, derived from agent kind + `systemSlug` → blueprint + the
  destination's `systemChannelType`/`dmKey`, never content. Both arms are
  surface-keyed — a PA presence in a shared room still carries its owner's
  identity, so the exemptions key on the surface, never the kind. Memory
  containment and realtime narrowing moved onto it; reply re-attribution and both
  *binding* waivers stay PA-only. `personalAssistantOnly` gains one arm
  beside the PA's: the blueprint's `identityToolIds` lists that id, the run is on
  the agent's own home DM, and `payload.interactive === true` with a live human
  requester whose id equals the stamped `effectiveUserId` — resolved **once** at
  run setup and passed to BOTH `resolveAgentTools` (the schema omits them, never
  offer-then-deny) and `authorizeToolCall` (a stale schema cannot be exercised),
  never to a delegate sub-agent. That interactive arm is the second of two locks
  with the `createAgentTrigger` refusal: remove either and an unattended run
  reconstructing an absent creator's `effectiveUserId` creates agents and
  channels as that person. Delegated reads it opens feed the disclosure sink.
- **`agent_handoff` passes the person, and its bounds are structural.** Any
  agent may hand a conversation to a global agent: a hidden server-authored
  `system` brief — the trigger-kickoff mechanism, never the integration
  handoff's `role:'user'` message rendering model text as the person's own
  editable words — into the *requesting person's* home DM, plus one doorway
  message in the origin room. The requester is the **actor**, never
  `effectiveUserId` (a PA presence carries its owner's while another member
  asks); with `interactive === true` and a live membership re-read, that also
  refuses every unattended, trigger, subtask and agent-authored run. Bounds are
  **withheld, not asserted**: the tool is omitted from any `systemSlug` agent's
  schema and from `spawn_subtask` children in `authorizeToolCall`, and one
  cooldown row per `(requester, slug)` converges retries and continuations onto
  the one briefing. The brief's basis subtracts **every scope the requester
  satisfies**, or the DM's only member cannot read its own specialist. Delivery
  is the one shared `deliverGlobalAgentBrief`, which claims the slot with
  `claimThreadRunOrPend`. `docs/global-agents.md`.

## Detail

Moved verbatim out of [`CLAUDE.md`](../../CLAUDE.md) → "Global agents — one blueprint, one row per organisation".


App-provided agents (the **Agent Designer**, `agent-designer`, is the first) are
blueprints in `@nessie/workspace-admin`, instantiated by `ensureGlobalAgent` as
one `systemManaged` row per organisation keyed by `Agent.systemSlug`, reachable
through a per-user private home DM (`gagent:{slug}:{orgId}:{userId}`,
`systemChannelType='system_agent'`, one member and one binding, both database
facts). Bootstrap runs beside the PA's at login and user provisioning but
**best-effort** (`attemptGlobalAgentsBootstrap`) — a global agent must never
lock anyone out. Invariants — the CHECKs, the ensure/policy-merge shape, the
binding, trigger and run-placement refusals, the un-gated list arm, the
delegation predicate with its one-arm identity-tool gate, and the handoff
bounds: [docs/standards/global-agents.md](global-agents.md).
The mechanics —
the Designer's toolset and shared reads, the generated capability catalogue,
`agent_handoff`'s delivery, the sidebar's second face, and the disabled detail
surface: [docs/global-agents.md](../global-agents.md). Spec:
[docs/plans/2026-09-02-agent-designer-global-agent.md](../plans/2026-09-02-agent-designer-global-agent.md).

**Direct messages lists conversations, not a directory.** Every DM channel there
is provisioned before anybody speaks — a person's DM, a private agent's home, a
global agent's home the moment the account exists — so listing provisioned
channels made the section a roster of the workspace, with the Agent Designer
pinned in it from day one. A row appears once its channel carries a message,
plus the channel the viewer is standing in, so opening a fresh conversation
never pulls its own row out from under them
(`admin/src/layouts/admin-shell/sidebar-dm-lists.ts`). Starring is unaffected —
it resolves through the full people directory, because starring somebody *is*
adding them. The doorways stay named: **Create → Message** (and the section's
`+`) reaches a person, **Create → Agent** opens the Designer's **chat**, the
form staying for field edits — the create menu's last row, and on the phone
sheet the last row *above* its morphing Message button
(`mobile/src/lib/native-creation-menu.ts`). One `openAgentDesignerChat` serves
every client via `POST /api/global-agents/:slug/home`, which *ensures* that DM.

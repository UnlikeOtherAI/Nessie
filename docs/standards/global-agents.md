# Global agents, specialist delegation and agent_handoff

Authoritative standard, moved verbatim out of [`AGENTS.md`](../../AGENTS.md)
so it is read when the work touches this area rather than loaded into every
session. `AGENTS.md` carries the one-line invariant and points here; **this
file is the rule**.

- **A global agent is a blueprint in code, one row per organisation, and a
  single-agent DM.** App-provided agents (the Agent Designer is the first) live
  in a registry in `@nessie/team-admin`; `ensureGlobalAgent` instantiates
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
  (`bindAgentToChannel`, both routes, the PA tool; `canModifyChannel` likewise
  refuses rename, archive and re-membering), `createAgentTrigger` refuses a
  `systemSlug` target (a scheduled run re-arms its creator's identity), and
  `assertGlobalAgentRunPlacement` admits, before any inference, only the home DM
  or an ordinary channel the agent is genuinely bound to. A global agent IS
  placeable in ordinary channels — and so in projects, whose reach is their
  channels — under the ordinary bind gates: the refusal narrowed from
  `systemManaged` to the Personal Assistant (its own presence path) and
  external-agent products, and `surfacePolicy` moved to `shared` so the stored
  row stops claiming DM-only. A shared room is advice-only: the
  identity-delegated tools stay gated on the agent's own home DM, so it never
  acts as whoever happened to speak. Reachability is the point of the tier:
  `listAgentsForUser`'s
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
  `agent_update`, `agent_tool_catalog`, `agent_avatar_generate`,
  `agent_avatar_update` are reachable only
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
- **An executor grant to an agent is whole-suite, never a per-operation pick by
  an agent.** If an agent has access to an executor, it has access to the whole
  suite of things available on that executor:
  `{ kind: 'agent_executor_grant'; agentId; state }` covers every operation key
  the executor's **active** capability revision names, intersected with
  `IMPLEMENTED_EXECUTOR_OPERATION_KEYS` and **excluding `workspace.promote`**,
  whose daemon path is real but which stays out of every model-facing toolset
  because only a person may issue a reviewed promotion. The stored change names
  no key: the set is derived at apply time
  (`resolveExecutorWholeSuiteOperationKeys`, over the one derivation
  `executorWholeSuiteOperationKeys` in `@nessie/schemas`), so a prepared change
  cannot grant an operation the reviewed revision does not offer.
  **"Active" means the LATEST revision, and only when its `reviewStatus` is
  `active`** — the definition `executor-binding.ts` and `executor-commands.ts`
  enforce, shared as `latestActiveCapabilityRevision`. Reviewing a revision
  never demotes the one before it, so superseded `active` rows persist: a
  reader that merely filters on status grants against a policy the daemon will
  refuse, and tells the person authorising it that a dead revision is live.
  **A revoke clears every grant row the agent holds on that executor, not the
  live policy's keys** — those two sets diverge the moment a revision narrows,
  and clearing only the live set leaves the dropped keys at `allowed`, dormant
  now and effective again the day a later revision re-adds them, with no
  confirmation and no fresh verification. For the same reason the
  no-live-policy refusal is an *allow* rule only: disabling an executor's last
  reviewed revision must never strand a grant with no way to take it back. An allow
  requires fresh verification exactly as one operation does, and confirming
  updates both halves — the logical executor tool policy first, so a failure is
  fail-closed — for every key in the set.
  **The two halves are scoped differently, and a revoke must respect that.**
  The logical tool policy is ORGANISATION-wide — one `executor.<operation>`
  registry entry, never a per-machine projection, because the machine is chosen
  later by the availability authority (`ensureExecutorLogicalTools`). The grant
  row is the per-machine half. The binding gate reads the policy entry with no
  executor dimension, so switching it off on a revoke withdraws the agent from
  EVERY executor, not the one whose owner withdrew consent. A revoke therefore
  disables the shared entry only for operations the agent holds nowhere else
  (`executorOperationKeysHeldElsewhere`), and that query excludes the executor
  being revoked, whose rows are still `allowed` at that point because the
  policy half is written first. Revoking a laptop once cut an agent off the
  server it was still granted on, and recovery needed a fresh prepare, confirm
  and password on the other machine. The per-operation kind and its tool
  stay: a *person* may still pick one capability on the Executors page. What no
  agent may do is issue that pick, because one confirmation per operation key
  is how an ordinary "let the researcher use my Mac" became a dozen reviews.
  `docs/global-agents.md`.
- **A grant is standing; reach is per run, and only a person opens it.** The
  whole suite lets an agent *use* an executor, never bind one. Executor tools
  reach a run only after a person binds that exact run: by launching it from
  the composer's **Run on executor**, or — for the local-apps pair only — by a
  later message of their own in the same conversation while their
  conversation lease is live. "That person started this run" is structural:
  the job's actor is the holder and nobody else, a continuation's press (the
  job's `resumedByUserId` — a card answer or an approval resumes as the parked
  run's actor, whoever pressed) is the holder's too, the run passes the
  interactive predicate above, and the trigger and every message of a drained
  batch carry the person-composer marker; the full definition is in
  [conversation-leases.md](../executor-protocol/conversation-leases.md). No
  agent binds itself, the PA and the Designer included, and a handoff, peer
  delegation or subtask never carries a lease, because a lease and its
  bindings pin one agent. The run is told its reach in one system fact outside
  the cache anchor — the servers it can use this turn, or that it has none and
  why — which names the machine only in the person's own DM.
- **An agent that has code written drives a coding agent; it never writes the
  code itself.** Fronting `claude mcp serve` handed the model Claude's own
  file and shell primitives, and a CTO asked to *instruct* ended up editing
  files itself — work it has neither the context nor the review loop for. So
  on a person's own machine the run is offered `coding_session_list`,
  `_start`, `_wait`, `_send`, `_interrupt`, `_review` and `_close` instead:
  each drives a Claude Code or Codex session on that machine, which reads,
  edits, tests and commits on its own. The agent briefs it like a senior
  engineer (the goal, the ticket, acceptance criteria, whether to open and
  merge a PR), waits with `coding_session_wait` — the worker's own poll,
  which returns when the turn ends, the session needs it, or the person
  writes — reviews what actually changed with `coding_session_review` before
  telling the person anything is done, and then sends feedback or closes.
  What the coding agent says is framed as the output of the agent it
  supervises: it is not the person, it cannot authorise anything, and its
  permission prompts are denied with a reason, never answered by the driving
  model. The tools exist only where a session may act as its machine's user:
  a private executor and a run its pairing owner started — the rule the API
  enforces on every call to the bridge (`EXECUTOR_CODING_SESSIONS_OWNER_ONLY`).
  A session outlives the run; the end of that person's lease or access, a
  paused machine, or their own Close on the executor page ends it. The
  contract is
  [host-coding-sessions.md](../executor-protocol/host-coding-sessions.md) →
  "The agent's tools" and "The executor page".
- **Executor management is gated on the delegation predicate, not on the
  Personal Assistant's kind.** `worker/src/run/pa-tools/executors.ts` keyed its
  gate on `agentKind === 'personal_assistant'` AND the PA's own
  `systemChannelType`, which is exactly the defect
  `runDelegatesToRequestingPerson` was written to remove — the Agent Designer is
  `agentKind: 'shared'` and delegates as completely inside its own home DM, so
  the whole executor estate was invisible to it with no failing check anywhere.
  The predicate replaces the kind test and nothing else: both its arms are
  surface-keyed, so a shared channel and a non-delegating agent are still
  refused, and `run.originatingUserId === actingUserId` still refuses an
  unattended run, which has no requester to act as and must never reconstruct
  one. A run with no loaded conversation fails closed. What the Designer reads
  through it is `listVisibleExecutors`' own entitlement — the person's, never
  wider — and the reviewed policy and local MCP report stay the administrator's
  read they already were. What it prepares is confirmed from a confirmation
  card in that same DM, never from a link: the card holds only the change's id
  and each press mints a fresh token for the person pressing it, until the
  change is confirmed, rejected or expires
  ([agent-cards.md](agent-cards.md) → "An executor review card holds an id").

- **A new agent lives where the person puts it, or nowhere yet.** Asked for a
  CTO, the Designer made a channel for it that nobody had asked for: its
  prompt said to "find or create" the channels the work happens in, the
  handoff summary named "the channel it works in", and the proposal card
  required "the channel it will work in" — so Accept, which builds exactly
  what the card says, built a room. The persona
  (`global-agent-blueprints.ts`) and the card section
  (`proposalCardSection` in `global-agent-catalogue.ts`) now say where an
  agent lives: the existing channels the person named, or nowhere yet, and
  the card's "Lives in" field reads exactly "nowhere yet — add it to any
  channel" when none was named. An agent with no binding is finished, not
  half-built — with one exception the persona states: an agent whose work is
  a project's board is lent its `ticket_*` tools only in a channel of that
  project it is bound to (`resolveProjectDelegatedToolIds`), so unplaced it
  holds grants no run ever lends. Such an agent lives in at least one existing
  channel of that project: the Designer asks which, or says plainly that its
  board tools do nothing until someone adds it to one. `channel_create` stays
  in the Designer's toolset and `identityToolIds` for a person who asks for a
  channel; it is never a default step. Pinned by
  `packages/team-admin/test/agent-designer-blueprint.test.ts`, the catalogue
  test and the proposal-card fixture suite (`admin/e2e/agent-proposal-card`),
  which renders both placements — the unplaced one a researcher, whose job
  needs no room, with no `#` anywhere on its card.
- **The Designer hands a person links, and its tools hand it data.**
  `agent_create`, `agent_bind_channel`, `agent_list`, `channel_create`,
  `project_create`, `project_list`, `team_create`, `agent_trigger_create`,
  `agent_trigger_list` and `agent_trigger_update` answer with markdown links —
  `[CTO](/agents/<id>)`, `[#sales](/channels/<id>)`,
  `[Marketing](/projects/<id>)`, `[Daily digest](/agents/triggers/<id>)`,
  built by the `format…MarkdownLink` helpers in
  `worker/src/run/pa-tools/tool-output.ts` — and `portrait: none (reason:
  "…")`, never `agentId=`/`channelId=`/`projectId=`/`triggerId=` pairs or an
  instruction addressed to the model. It relayed both verbatim: the person
  read UUIDs and "give them this reason word for word". A later call takes the
  id from the link's last segment, and the model is told so — in the
  Designer's prompt and in each of those tools' own descriptions — rather than
  left to guess; every tool that takes one of those ids takes it exactly as
  before. A trigger's `/agents/triggers/<id>` also reads as "an `/agents/…`
  link", and `agent_trigger_create` prints it before the agent's, so the
  prompt and the descriptions name the agent's as `/agents/<id>` and say a
  trigger link is never an agent's. A team has no page to link, so
  `project_create`, `project_list` and `team_create` name it as
  `"Core" (teamId=<id>)` — the one raw id they still print, because
  `channel_create` takes it — and `project_create` keeps it in its result so
  that call never depends on the model still holding its own arguments.
  Real-row tests parse the id out of a result and make the next call with it:
  `agent_create` → `agent_bind_channel`, `project_create` → `channel_create`
  (project and team both read from the result), `agent_list` →
  `agent_update`, and `agent_trigger_create` → `agent_trigger_list` →
  `agent_trigger_update` (`worker/test/db/designer-team-structure.test.ts`).
  `project_create`'s "no second channel unless asked" (its description's rule
  and the prompt's) and `channel_create`'s next steps (its description's) are
  no longer lines in their results. `agent_bind_channel` and
  `agent_trigger_create` read the names they link, so each stamps those names
  exactly as `agent_list` stamps them; `agent_trigger_create` reads the room's
  through the caller's own `buildVisibleChannelWhere`, because
  `createAgentTrigger` checks only the agent's binding and resolves a thread's
  room itself — an owner outside a private room gets
  `[#channel](/channels/<id>)` and no stamp. `agent_trigger_delete`,
  `agent_unbind_channel` and the `channel_list`/`channel_find` reads still
  print raw ids. `agent_avatar_generate` reports a pinned style as
  `style: pinned at the <scope> level; the requested "…" was not applied`
  rather than "Say so". Quoting the portrait reason, reporting a pinned style
  and never showing a raw id are rules in the Designer's own prompt, where
  instructions belong.

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
  `claimThreadRunOrPend` and stamps the brief's own action purpose,
  `global_agent.brief` (`GLOBAL_AGENT_BRIEF_PURPOSE`). The purpose is what lets
  a brief that pends behind a busy DM **drain alone**. Folded into an ordinary
  batch, only the latest row drives the run and a hidden `system` row is never
  history, so the brief would be lost behind the person's next message.
  `docs/global-agents.md`.

- **A hidden kickoff that carries its own requester drains alone.** When the
  target slot is busy, `drainPendingThreadMessages` batches ordinary pending
  rows, and a batch runs under its *latest* row's prompt, actor context,
  principal, trigger and reply root. That is right for chat turns and for
  scheduled "check for work" kickoffs. It is wrong for any kickoff whose
  payload and identity are its own. `DRAINS_ALONE_PURPOSES` in
  `packages/db/src/thread-serialization.ts` is the one list of those purposes:
  `agent.peer_delegation`, `task_set.delivery` (a task set's receiver
  delivery, under its owner and `task-set:<id>` correlation),
  `mailbox.delivery` (any other agent mail, including plan and workflow step
  mail, whose follow-up is also linked to its step through the pending row's
  `mailboxMessageId`), `global_agent.brief` and `ticket.work`
  (`TICKET_WORK_PURPOSE`: a ticket's work-record wake, which acts as the agent
  with no effective user, so a person's message is never consumed by it).
  Each such row becomes a follow-up run of its own, in arrival order, and
  ordinary rows before it drain as their usual batch. The purpose is already
  in the pending row's stored actor context, so no column marks it. A new
  kickoff of this kind — a delivery, a wake, a brief — adds its purpose to
  that set in the same change. `worker/test/db/task-set-delivery-drain.test.ts`,
  `worker/test/db/agent-handoff-drain.test.ts`,
  `worker/test/db/mailbox-step-delivery-drain.test.ts` and
  `packages/db/test/thread-serialization-ticket-work.test.ts`.

- **Every path that starts a run in a single-member delegated system DM stamps that member as `effectiveUserId`, or the run silently loses its identity tools.** The gate above requires `effectiveUserId === actorId`, and an unstamped run does not fail: it resolves no requester, the tools are absent from the model's function set, and the agent truthfully reports it cannot create anything. The stamp lived inline in `thread-message-create.ts` and was missing from the agent-card press, so a *typed* message worked while a button press did not — in the one agent whose whole style is card-driven. `isDelegatedSystemDmChannelType` and `withDelegatedSystemDmIdentity` are now ONE definition in `@nessie/schemas` (the predicate had existed twice, once per process, each copy warning that the other must not drift), and `enqueueOrchestrateDecide` (`packages/db/src/queue.ts`, shared by the API and the worker's `send_message` tool, both of which wake the same `orchestrate.decide` topic) resolves the destination channel itself and applies it, so every human-turn wake path is correct without its author knowing this rule exists; a caller-supplied `systemChannelType` is exactly the argument a new path forgets. `enqueueRunExecution` gets no such chokepoint — its callers build actor contexts from six provenances and a blanket stamp would guess whose identity is in play — so each call site is classified `stamps`/`inherits`/`unattended` in `api/test/delegated-system-dm-enqueue-sites.test.ts`, which fails until a new one records a verdict. A resumed run is the case worth naming: a `wait: true` card parks its run and the press resumes from the *parked* run's actor context, so `run-resume-core.ts` re-asserts the destination's rule rather than trusting what it inherited. `docs/global-agents.md`.

## Detail

## Bounded ordinary-agent project collaboration

Ordinary shared agents do not wake one another by posting a chat message: the
channel orchestrator accepts human turns only. Any member of the project may
explicitly grant an ordinary agent `agent_peer_delegate` and the selected
project ticket tools. On a live project-channel turn, or a bounded durable peer
delivery from one, the worker re-reads the original requester. Peer delegation
and board creation require `canModifyProject` (any member of the project, or
an organisation owner or admin); ticket operations mirror
the existing live project-access gate. The target must be a
non-system shared agent already bound to that exact channel. The durable mailbox
row carries the requester capability, a maximum depth of four, and the source
basis from the delegating run; ordinary mailbox traffic has none of those. On
delivery, the mailbox service validates that durable basis, stamps it onto the
peer's prompt and run, and the usual reply-basis predicate re-evaluates current
audiences and disclosure grants when the coordinator's output is read. This
permits a researcher/coordinator review cycle without turning agent-authored
messages into unbounded orchestration, widening a source audience, or letting
ambient session scope decide what project an agent can change.

Peer deliveries use the authorized destination channel's project and team
attribution and retain the original human as the effective user. Their durable
mail also carries that action's captured UOA subject/org/team/epoch tuple only
as immutable run provenance: it is neither a credential nor a local identity
record, and Ledger revalidates it against the original human's live link at
admission. Missing or malformed provenance fails closed. When a target thread
is busy, peer briefs drain one at a time in FIFO order: a later schedule or
another peer cannot replace the selected hidden message, requester, or source
basis. Task-set receiver deliveries and global-agent briefs follow the same
rule (`DRAINS_ALONE_PURPOSES`, above). A terminal peer failure posts one useful result through the ordinary run
lifecycle for the waiting conversation; it does not retry or acknowledge itself.

An automatic continuation keeps the originating run's reply placement, so every
part remains visible in that same conversation and reloads the checkpoint keyed
to that placement. It does not create a second peer protocol or alter the
captured requester, UOA provenance, or disclosure basis.

The same project-channel binding is re-read for every delegated ticket call.
Content-bearing ticket, board, and checklist writes share
`assertProjectWriteDestination`: they refuse material the run consumed from a
scope the destination audience does not imply. Checklist snapshots additionally
require that each project collaborator can see the template's source agent.
The lendable set is `PEER_PROJECT_TOOL_IDS`; it now includes
`ticket_labels_read`, `ticket_label_create`, `ticket_comment_list`,
`ticket_comment_add`, `ticket_attachment_list` and `ticket_attachment_add`,
but not comment edit/delete or file removal. The full ticket tool list is in
[`docs/global-agents.md`](../global-agents.md) → "Project tickets from the
Personal Assistant"; the comment, file and label invariants are in
[ticket-activity.md](ticket-activity.md).

A lent tool is one the agent's policy sets `true`
(`resolveProjectDelegatedToolIds`); an absent key lends nothing. So every
catalogue that tells an author how to grant a tool treats a
`projectDelegatedOnly` builtin as allow-mode, off by default, exactly like an
explicit grant: the Agent Designer page's own catalogue
(`admin/src/facades/designer/tool-catalog.ts`) and the member-safe projection
the Designer's prompt and `agent_tool_catalog` render
(`loadAgentToolCatalog`, which also marks each one `projectChannelOnly`). A
catalogue that derived the mode from `requiresExplicitGrant` alone told the
Designer these tools were "on by default", and it built a board-owning agent
without a single ticket tool. Only `ticket_board_create` is also
`requiresExplicitGrant`, so it alone stays with the owner grant verbs; the rest
are ordinary policy keys `agent_create` and `agent_update` accept.

A lent tool that takes a `projectId` does not require one: omitted, it is the
channel's project (`ticketProjectIdFor` in
`worker/src/run/pa-tools/ticket-context.ts`), which is the only project
`projectFor` lets a shared agent touch anyway. The agent holds no
`project_list`, so no refusal it can receive points there — a named project
elsewhere is refused with "omit projectId", and a requester who cannot open the
project is told exactly that. Do not "fix" a missing id by having the agent
call `channel_list`: it names a channel's project, never its id. (Listing
channels does not stamp the run's disclosure basis; reading a channel's content
does, and that stamp blocks the project write.) The Personal Assistant works
across projects and still names one.

A run lent any of these tools that writes recalls memory under project-write
containment: only organisation and same-project material, never a thought fed
by a private conversation (`requiresProjectWriteRecallContainment`,
`worker/src/run/execute/memory.ts`). Otherwise a memory of the requester's DM
put that DM in the run's basis before its first action and the write gate then
refused every ticket write. Its memory and history searches go deeper
(`PROJECT_WRITE_RECALL_DEPTH`) and keep the normal count of what passes, so the
narrowing does not leave the recall short. The rule and its trade-off are in
[disclosure-boundaries.md](disclosure-boundaries.md).

Moved verbatim out of [`CLAUDE.md`](../../CLAUDE.md) → "Global agents — one blueprint, one row per organisation".


App-provided agents (the **Agent Designer**, `agent-designer`, is the first) are
blueprints in `@nessie/team-admin`, instantiated by `ensureGlobalAgent` as
one `systemManaged` row per organisation keyed by `Agent.systemSlug`, reachable
through a per-user private home DM (`gagent:{slug}:{orgId}:{userId}`,
`systemChannelType='system_agent'`, one member and one binding, both database
facts). Bootstrap runs beside the PA's at login and user provisioning but
**best-effort** (`attemptGlobalAgentsBootstrap`) — a global agent must never
lock anyone out. Invariants — the CHECKs, the ensure/policy-merge shape, the
binding, trigger and run-placement refusals, the un-gated list arm, the
delegation predicate with its one-arm identity-tool gate, and the handoff
bounds: stated above. The mechanics —
the Designer's toolset and shared reads (the three executor verbs included),
the generated capability catalogue and its executor section,
`agent_handoff`'s delivery, the sidebar's second face, the address book and
the disabled detail surface: [docs/global-agents.md](../global-agents.md). Spec:
[docs/plans/2026-09-02-agent-designer-global-agent.md](../plans/2026-09-02-agent-designer-global-agent.md).

**Direct messages lists conversations, not a directory.** Every DM channel there
is provisioned before anybody speaks — a person's DM, a private agent's home, a
global agent's home the moment the account exists — so listing provisioned
channels made the section a roster of the team, with the Agent Designer
pinned in it from day one. A row appears once its channel carries a message,
plus the channel the viewer is standing in, so opening a fresh conversation
never pulls its own row out from under them
(`admin/src/layouts/admin-shell/sidebar-dm-lists.ts`). **A person's DM row then
lasts `DM_QUIET_DAYS` — 14 — from the last thing said in it**, because a list of
everyone they have ever messaged is the roster again a year later; messaging
that person again brings the row straight back, since the only thing that ages
out is the row. The channel, its history and its URL are untouched, and every
door back to it (the section's `+`, a project member row, any `useNavigateToDm`
caller) resolves that same DM through `POST /api/dm/:userId`. Two facts outrank
the window because hiding the row would cost the reader something: the channel
they are standing in, and a DM still holding unread messages. Agent DMs keep the
plain "has a message" rule — `ChannelRecord.lastMessageAt` is the default
thread's only, so an agent DM busy with conversations reads as silent and would
age out while in daily use (`docs/plans/2026-09-08-agent-conversations.md` →
Later). Starring is unaffected —
it resolves through the full people directory, because starring somebody *is*
adding them, and a starred person renders in Starred rather than here, so an
explicit "keep this" never depends on recency. The section's `+` owns the combined doorway: its **People** tab
starts a human conversation, while **Agents** both addresses an existing agent
and creates a new one after the person explicitly chooses **Private** or
**Public**. Public means organization-visible and inviteable to any normal
channel; Private means owner-only and DM-only. **Create → Message** and
**Create → Agent**, including the native phone sheet, deep-link to the matching
tab of that same flow rather than maintaining another creation path.

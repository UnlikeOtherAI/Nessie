# The Agent Designer — the first global agent

**Status: built.** Phases 0, 1, 2a, 2b, 3 and 4 all implemented 2026-09-02.
Revised 2026-09-02 after independent Kimix and Codex Sol code-aware reviews
(see "Cross-model review"); every adopted finding was re-verified against code
first.

## As built (2026-09-02)

**Shipped.** The Agent Designer is a real global agent: one `systemManaged` row
per organisation keyed by `Agent.systemSlug`, a per-user `gagent:` home DM
bootstrapped at login, the identity-delegated tool gate, the design tools, a
generated capability catalogue, `agent_handoff` with its routing block and
origin-thread doorway, the field-sensitive edit-authority model underneath all
of it, a read-only configuration view for any Nessie-managed agent, and one
persona shared by the DM and the Agent Designer page's sidebar. Creating and
redesigning an agent is now the Designer's alone: those tools are
`identityDelegatedOnly`, so the Personal Assistant hands off instead of carrying
the design catalogue.

**Deferred, deliberately.** No avatar *image* at bootstrap (a billed call), only
a stable tile colour, with generation left to the PA's lazy owner-triggered
path. Binding a global agent into ordinary shared channels stays with the scopes
doc's later phase; v1 global agents are DM-homed and own no triggers. The sidebar
keeps its ephemeral in-process transport rather than becoming thread-backed
(D9's named end state). There is no `agent_delete` for anyone, and no
policy-target or explicit-grant mutation from either face.

**Owed: a Playwright pass.** Both mandatory dev ports (`:5454`, `:5455`) were
held by another session's live stack throughout phase 4, and neither killing
them nor moving these services elsewhere is allowed. Four screens still need a
browser: the Agents page Global tab listing the Designer, its read-only detail
view, the Designer's DM opening from the sidebar, and the handoff doorway in an
origin channel. Verified without one: the whole lint gate, the api/worker/admin
suites, `tsc --noEmit` for all three, a clean production admin bundle.
**Date:** 2026-09-02
**Related:**
[2026-08-30-agent-scopes-personal-team-global.md](2026-08-30-agent-scopes-personal-team-global.md)
(global agents = app-provided, per-org bootstrap rows; reachability was
deliberately left as "a later phase" — this plan is that phase, for one agent),
[2026-08-31-conversational-agent-setup/overview.md](2026-08-31-conversational-agent-setup/overview.md)
(the chat-first creation grammar and the Design Assistant sidebar; this plan
**supersedes** its "no general `agent_update`" decision — see D4),
[2026-08-29-people-and-their-agents.md](2026-08-29-people-and-their-agents.md),
[2026-09-01-agent-chat-cards.md](2026-09-01-agent-chat-cards.md).

## Outcome

Nessie ships its first **global agent**: the **Agent Designer**. It is
hard-coded in the deployment (a code blueprint, instantiated per organisation by
bootstrap, exactly the Personal Assistant / Librarian pattern), not editable by
anyone, and it owns one job: talking to a person about the agent they want —
what work it should do, whether there are specialist tasks, what it needs access
to — and then creating or reshaping that agent through the same chokepoints the
Agent Designer page uses. It collects structured answers with interactive cards,
and it is the one place in the product that holds the complete, generated
catalogue of every agent parameter and every tool.

Every other agent knows, structurally, that agent design is the Designer's job.
Asked to "create an agent that does X", an agent answers in its own words and
**hands the conversation off** — `agent_handoff` opens (or continues) the
person's private Designer DM with a server-authored briefing and leaves a
doorway behind in the original conversation. The big design-catalogue context
lives only in the Designer's own runs; no other agent carries it, and the design
verbs themselves are reachable from nowhere else.

The Design Assistant sidebar on the Agent Designer *page* becomes a second face
of the same agent: one blueprint module supplies the persona and the generated
capability catalogue to both the page's form-filling transport and the chat
agent, so there is one brain with two doorways rather than two brains.

## What existed before this (verified 2026-09-02)

The starting point, kept because every design decision below is an answer to
one of these facts.

- **The global tier existed but was unreachable.** The DB CHECK admitted a
  `systemManaged` shared agent and the Librarian and external-agent products
  used it — but `bindAgentToChannel` refused every `systemManaged` agent,
  `isAgentVisibleToUser` hard-coded `systemManaged: false` (list-only, no
  detail), and an *unbound* global agent was invisible to everyone. The scopes
  doc named the fixes; none was built.
- **Bootstrap and per-user system DMs had solid precedent**
  (`ensurePersonalAssistantAgent` and friends: advisory lock →
  find-by-discriminator → create-or-update, config merged under the per-agent
  policy lock). Discriminators were ad-hoc, though — the Librarian is keyed by
  *name*. The PA DM (`pa:{org}:{user}`, membership forcibly reduced to one) is
  where `effectiveUserId = poster` is stamped, safe exactly because the DM has
  one member, and where the orchestrator's structural fast path replies without
  an engagement judgement.
- **The provisioning tools existed, PA-only** (`agent_list`, `agent_create`,
  `agent_bind_channel`, `agent_trigger_create`, `channel_create`), each
  mirroring one route's authorization. There was deliberately no `agent_update`
  and no `agent_read` — and no per-agent record route at all; the admin detail
  page read the record out of the entitled list.
- **Cards already did forms.** `card_post` carries `input` blocks and up to
  four actions, `wait: true` suspends into `waiting_input` through the approval
  machinery, and a press is a real `user` message read structurally. A
  `waiting_input` run **holds the `(agent, thread)` slot**.
- **The Design Assistant sidebar was a second brain.** `POST /api/designer/chat`
  is a stateless in-process SSE loop with its own prompt, its own tool
  vocabulary, its own DuckDuckGo scraper, and no persistence.
- **No conversation-transfer primitive existed.** Agent-to-agent reach was the
  orchestrator (guarded by `triggerIsHuman`), the PA's `send_message` (posts as
  the owner), the owner-only mailbox, and the server-authored integration
  handoff. That last is the pattern D8 reuses — with two corrections: it
  impersonates the requester with a `role:'user'` message, and it bypasses
  `claimThreadRunOrPend`.

## Design decisions

### D1 — Blueprint registry + a durable system slug

A **global-agent blueprint registry** in code, in `@nessie/workspace-admin`
(both API and worker need it; api services re-export as usual):

```ts
interface GlobalAgentBlueprint {
  slug: string                      // 'agent-designer'
  name: string                      // 'Agent Designer'
  role: string
  buildSystemPrompt(ctx): string    // persona + generated capability catalogue
  toolPolicy: Record<string, boolean>
  identityToolIds: string[]         // PA-only tools this blueprint may use (D3)
  provider?: string                 // null ⇒ the org's default model
  model?: string                    //   (the Librarian's cost stance);
                                    //   NESSIE_DESIGNER_MODEL env overrides both faces
  effort: AgentEffort               // 'medium'
  runLimits?: AgentRunLimits
  home: 'per_user_dm'               // v1: DM-homed only
  allowsSelfTriggers: false         // v1: no automation on a global agent (D3)
}
```

New column **`Agent.systemSlug String?`**, unique on
`(organizationId, systemSlug)`, CHECK `systemSlug IS NOT NULL ⇒
(systemManaged AND organizationId IS NOT NULL)` — the org-not-null arm makes
"per-org rows, nothing cross-org" a database fact, not prose. This is the
discriminator the ensure function keys on — replacing name-keying (the
Librarian's fragility) for new global agents, and giving the worker a
structural way to know *which* global agent a run belongs to (D3, D8).
Backfilling PA/Librarian/external agents onto it is a follow-up, not
required here.

`ensureGlobalAgent(blueprint, orgId)` follows `ensurePersonalAssistantAgent`
exactly: advisory lock on `(orgId, slug)`, upsert by `(orgId, systemSlug)`,
config merge under `acquireAgentToolPolicyLock`, never clobbering targeted
grants. Updates ship by redeploy (the scopes doc already adjudicated
code-registry over a DB catalog). Bootstrap runs where the PA's does (login,
provisioning) plus lazily from the surfaces below.

**The Designer's shape needs a fourth CHECK tuple — already shipped.** The
Designer is DM-homed and acts as the requesting user, i.e.
`(systemManaged=true, shared, dm_only, act_as_requesting_user)`, which
`agents_system_managed_invariants_chk` forbade. (Note: `createExternalAgentData`
already wrote exactly this tuple and violated the committed CHECK — a latent
bug caught while mapping this. Fixing it legalizes the shape both need, so
migration `20260902170000_external_agent_surface_invariants` ships that fourth
tuple; the Designer work must **not** add a second one.)

### D2 — Home surface: a per-user private DM

`dmKey = gagent:{slug}:{orgId}:{userId}`, `type='dm'`,
`visibility='private'`, single member (forcibly reduced, PA-style), in a
hidden system team, with a new `systemChannelType = 'system_agent'`. The DM
key CHECK (`channels_personal_assistant_surface_chk`) must admit the new
prefix **in the same migration**. The `extagent:` lesson is not hypothetical:
`external_agent` was added to `ChannelSystemType` without that CHECK learning
the key, so every external-agent DM insert violated it until migration
`20260902170000_external_agent_surface_invariants` added its arm. Add
`system_agent` the same way — an arm keyed to its own system-channel type,
never a widened pattern.

**Database invariants beyond the key shape** (from the private-agent-home
precedent, both adopted from review):

- The deferred home-membership trigger
  (`assert_private_agent_home_members`, migration `20260830300000`) parses
  only `agent:` keys (owner = segment 3). A sibling arm for `gagent:` keys
  (owner = segment 4) enforces "exactly the encoded user is the member" at
  the storage layer — D3 treats sole membership as an identity fact, so it
  must hold at rest, not just at bootstrap.
- **No second agent may ever bind into a system DM.** `bindAgentToChannel`
  refuses only `personal_assistant` system channels today; the refusal
  widens to *any* non-null `systemChannelType` (and `unbindAgentFromChannel`
  learns the same scope). Without this, an ordinary agent bound into the
  Designer DM reads the whole design transcript and breaks the
  single-candidate fast path.
- **System channels are lifecycle-protected.** The `channel-manage.ts`
  chokepoints (rename, archive, membership) refuse channels with a non-null
  `systemChannelType` (the PA-channel refusals generalised), and the
  bootstrap unarchives/repairs its DM if a historical mutation got through.

Three things hang off the channel type, all mirroring the PA DM:

- `thread-message-create.ts` stamps `effectiveUserId = poster` (safe: one
  member, DB-enforced), so the Designer acts as the person it is talking to.
- The orchestrator's structural fast-path replies to every user turn without
  an engagement judgement (generalize `resolvePersonalAssistantDecisions`
  to single-member system DMs, keyed on the channel type — never on content).
- The worker asserts at run start that a `systemSlug` agent with
  `home: 'per_user_dm'` only ever runs in its own DM (the private-agent
  run-start assertion, reused). Trigger threads are **not** in the allowed
  set: v1 global agents carry `allowsSelfTriggers: false`, and
  `createAgentTrigger` refuses a `systemSlug` target — a scheduled run
  re-arms the creator's `effectiveUserId`, which would hand identity tools
  to an unattended run (D3).

Why a DM and not presence in the asking channel: the person said it
themselves — the design catalogue is big, and creation is a focused,
personal conversation. Isolation is the point. General bindability of global
agents stays with the scopes doc's later phase; this plan does not need it.

**Doorways (Rule zero) — the admin work, enumerated** (review showed the
"external-agent precedent" alone is not enough; that precedent is pinning +
de-duping, and the generic DM list drops any DM whose agent is not in the
default `useAgents()` result, which excludes system agents):

- `useSidebarDms` gets a `system_agent` branch resolving the Designer
  through the identity directory (like `sidebarProductAssistants`), and the
  `isUserDmChannel` / `hasRespondingAgent` predicates
  (`facades/personal-assistant/hooks.ts`) learn the new channel type so the
  DM is not misclassified as a user DM and the liveness hint fires.
- `useChannelParticipants` and the Channels page resolve the Designer
  binding through `AgentIdentityProvider`, which learns to serve global
  agents (today it only merges the PA) — necessary but, alone, insufficient.
- The Agents page Global tab lists the Designer even when unbound (adopt
  the scopes doc's `{ systemManaged: true }` list branch); the Agent
  Designer page links "Chat with the Agent Designer"; `agent_handoff` (D8)
  is the in-context doorway from every other conversation.
- Unread counts, channel-gated realtime, and push need no new work: the DM
  is an ordinary private channel and Designer runs are `interactive: true`
  (both reviewers confirmed this holds once the DM exists).

### D3 — Identity-delegated tools: generalize the `personalAssistantOnly` gate

The Designer needs `agent_create`, `agent_bind_channel`,
`agent_trigger_create`, `channel_create`, `agent_list` — all flagged
`personalAssistantOnly`, gated on `agentKind === 'personal_assistant'`.
Rather than fork designer-specific copies (the eighth look-alike), the gate
widens by one structural arm:

> a `personalAssistantOnly` tool is allowed when `agentKind` is PA **or**
> the run's agent has a `systemSlug` whose blueprint lists the tool in
> `identityToolIds` **and** the run is on the agent's own single-member DM
> surface **and** the run is an interactive human turn.

The plumbing is the real work, and it is specified, not hand-waved:

- `resolveAgentTools` / `authorizeToolCall` (`worker/src/run/tool-policy.ts`)
  today receive only `agentKind`, `parentAgentId`, `toolPolicy`, and the
  presence flag. The run context grows two structural inputs — the
  destination's `systemChannelType`+`dmKey` (already loaded at run setup)
  and the agent's blueprint (resolved once from `systemSlug`) — threaded
  from `run-setup.ts` into **both** call sites: toolset assembly, so the
  Designer's schema array simply omits identity tools outside its DM
  (never offer-then-deny), and per-call authorization, so a stale schema
  cannot be exercised.
- The **interactive-human-turn condition** (`payload.interactive === true`
  and a live human requester) is part of the gate itself, not left to each
  handler: a trigger-fired run reconstructs the creator's
  `effectiveUserId`, and without this arm a scheduled global-agent run
  could create agents and channels as an absent person. Belt: v1 global
  agents cannot own triggers at all (D2).
- **The delegation semantics move onto one predicate, not just the tool
  gate.** The worker keys "acts as the requesting user" on
  `agentKind === 'personal_assistant'` (or the PA channel type) in at least:
  memory scope resolution (`execute/memory.ts`), websocket scope narrowing
  (`execute/scopes.ts`), delegated reply attribution
  (`execute/completion.ts`), the trigger membership re-check
  (`control/trigger-run.ts`), and the acting-member helpers
  (`pa-tools/access.ts`). Phase 2 introduces one shared structural
  predicate — "this run delegates to its requesting user" — derived from
  agent kind **or** blueprint declaration plus the home-DM surface, and
  re-keys each listed site onto it (or records, per site, why it stays
  PA-only). Without this the Designer would get PA *tools* with ordinary
  shared-agent *memory, scopes, and attribution* — the premise broken
  silently.

The surface condition matters: these tools exercise the person's identity
(`resolveActingMember` from `effectiveUserId`), which is exactly why they
were PA-only. The Designer gets them only where `effectiveUserId = poster`
holds by construction. The PA-presence reduction discipline
(`isPersonalAssistantPresenceRun`) applies unchanged if a global agent is
ever bound into a shared room later.

### D4 — The Designer's toolset

Reused as-is (via D3 where PA-only):

| Tool | Why |
|---|---|
| `agent_list` | resolve "my triage bot" to an id; see bindings |
| `agent_create` | the create chokepoint (`createAgentRecord`), incl. private agents + home DM. Today the *route* auto-generates an avatar and the PA tool path does not — the generation moves into a shared seam both call, in the same change, so a chat-created agent is not the only faceless one |
| `agent_bind_channel` | place the new agent (all four route gates) |
| `agent_trigger_create` | schedules on *designed* agents, with the UOA-identity refusal intact; refuses `systemSlug` targets (D2) |
| `channel_create` | "it needs its own channel" |
| `card_post` | forms and choices (D6) |
| `web_search`, `web_fetch` | research a service/domain before writing the prompt |
| `people_search`, `channel_find`, `channel_list` | resolve names the person uses |
| `document_read`, `kb_search`, `kb_page_read` | ground a prompt in existing material when asked |

**Every delegated read above feeds the disclosure sink.** The pa-tools read
paths (`channels.ts`, `provisioning.ts`, knowledge reads) do not call
`consumedSources` today; in the owner-only PA DM that is tolerable, but the
Designer's replies can be handed onward (D8 briefs, future shared surfaces),
so the reads acquire their scope stamps in the same change that widens them
— the AGENTS.md read-feeds-the-sink rule applied to this toolset.

New builtins (shared function in `@nessie/workspace-admin`, api service
re-exporting; a tool that takes an id ships with the read that resolves it):

| Tool | Authorization | Notes |
|---|---|---|
| `agent_read` | there is **no per-agent record route to mirror** (review finding — the admin reads the record out of the entitled list). A new shared read, `readAgentRecordForActor`, applies exactly the list entitlement (`buildVisibleAgentWhere` + visibility) and returns the same `AgentRecord` projection the list returns. For `systemManaged` agents it returns a **config-only projection** (name, role, prompt, policy, model — never activity/messages/children), which is also what the read-only global detail view renders (D7). Reading an agent's full config is a scoped source: the read feeds the sink with the `agent:` scope. |
| `agent_update` | the deliberately-missing tool, now homed where it belongs. Gated by `canEditAgent` (see "Edit authority") with **field-sensitive** enforcement: the edit-field set only; `ownerUserId` transitions and `todosEnabled` keep their own narrower gates. `mergeGenericAgentToolPolicy` + `assertGenericAgentToolPolicyInput` stand; `systemManaged` targets refused **in the service** (see D7 — today only route invisibility protects them). This deliberately **supersedes** the conversational-setup decision "no general runtime `agent_update`": that decision guarded against a *run rewriting itself*; the Designer is a different principal editing *another* agent under the person's live authority, and the self-rewrite ban stays (the Designer's own row is blueprint-only). The conversational-setup doc is amended in the same change. |
| `agent_tool_catalog` | read-only live catalogue. **A new member-safe shared projection** — `GET /api/mcp/tools` is org-owner-only and must not be widened; the new read serves exactly what the designer page's `tool-catalog.ts` computes (builtins deny-mode; active, non-protected connector tools allow-mode keyed by registry uuid; explicit-grant tier named in words, never togglable) through a presenter that can never emit credentials, endpoints, or grant state. Served server-side so the two faces cannot drift. |
| `agent_avatar_update` | mirrors `PATCH /api/agents/:id/avatar` + `POST …/avatar/generate`, gated by `canEditAgent` like those routes become. |

Deliberately **not** given: `connector_*` mutations (the conversational-
setup plan is retiring them; the Designer points at `/apps` and the
`app_connect_request` flow in words), any policy-target/grant mutation for
explicit-grant tools, agent delete (doesn't exist for anyone), DeepWater
bundle management, and `spawn_subtask`/`delegate` (a design conversation
needs neither; keeping them off keeps the catalogue-laden context from
fanning out).

### D5 — The capability catalogue is generated, never written

The Designer's authority is a structural system-prompt block **generated
from the same sources the product uses**:

- **Parameters** from the contracts: name, role, visibility
  (`workspace`/`private` + the private-agent consequences: owner-only home
  DM, unbindable, untransferable, immutable), model + provider (live
  `listLedgerAgentModels` — the exact-pair rule stated), effort
  (`low|medium|high|xhigh` → `reasoning_effort` only), `runLimits` (five
  dims + backstop semantics), `todosEnabled` (org-owner-gated), system
  prompt, avatar, bindings, triggers (types + the UOA-identity requirement
  for schedules).
- **Tools** from `BUILTIN_TOOL_DEFINITIONS` + the org's live registry rows:
  id, summary, deny-mode vs allow-mode, PA-only (excluded from shared
  agents), explicit-grant (owner surfaces, named in words), to-do gating.
- **What it may never do**, stated as facts: protected policy keys are
  server-owned; system agents are read-only; visibility is immutable;
  private agents belong to their owner alone.

**Assembly points, named:** the worker face assembles the block at run
setup (`run-setup.ts`, where `BUILTIN_TOOL_DEFINITIONS` and the registry
rows are already in hand). The sidebar face today builds its prompt from
form state plus a *client-supplied* tool list; unification (D9) moves both
onto one blueprint module in `@nessie/workspace-admin`, and gives the api
designer service its first read of the live registry — a new, explicitly
named dependency, using the same member-safe projection as
`agent_tool_catalog`.

Hand-written prose about parameters is forbidden in the prompt — the block
renders from code, so a new tool or field is in the Designer's knowledge the
deploy it ships (the same discipline as the research-routing and agent-docs
prompt blocks). Because this block is large, the Designer's own `toolPolicy`
keeps its builtin set small (D4) so the context budget goes to the catalogue
and the conversation.

### D6 — Persona and conversation shape

The persona part of `buildSystemPrompt` stays short and goal-shaped, per the
product direction: the Designer's job is to **understand what the person
wants the agent to do** — the work, the specialist tasks, the cadence, what
it needs to reach — and only then configure. It asks the next real question
rather than a questionnaire; it proposes a complete draft early and iterates;
it uses a card when a structured answer is genuinely better than prose
(choices from a list, several short fields at once) and plain chat otherwise;
it always says what it created and where it lives (link the home DM /
channel). No scripted example flows are baked into the prompt — the shape of
any given setup is the model's judgement in the person's own language
(the no-string-matching rule applies to it like every agent).

Card mechanics, corrected against the cards spec (review finding): a
`wait: true` card parks the run in `waiting_input`, and that run **holds the
`(agent, thread)` slot — ordinary chat messages pend behind it** until the
card resolves, is cancelled, or hits the backstop. So "answer in chat
instead" and `wait: true` are mutually exclusive by construction. The
Designer therefore posts cards **without `wait` by default** — the person
may press *or* reply, and either wakes it (a press through the structural
card path, a reply through the DM fast-path) — and reserves `wait: true`
for the moments a structured answer is genuinely the only next step (a
secret, a must-pick choice), always with an expiry. `select` options cap at
20, so long lists (models) are offered as a shortlist with "or name
another".

### D7 — Not editable, by construction

Mostly true today, with one correction the review surfaced:
`createAgentRecord` refuses system-managed input, the clone route refuses
system sources, and every `/api/agents/:id/*` route 404s on system agents —
but `updateAgentRecord` does **not** refuse an *existing* system-managed
row; it merely pins name/owner/todos and would happily rewrite prompt,
policy, and model if anything could reach it. Route invisibility is the only
protection, and this plan removes route invisibility (config reads, D4).
So phase 0 adds the explicit refusal in `updateAgentRecord` and the avatar
service — `systemManaged ⇒ SYSTEM_AGENT_IMMUTABLE` — before any read path
widens.

The read-only global detail view is the D4 **config-only projection**,
deliberately *not* a widening of `isAgentAccessibleToActor`: that predicate
gates status, activity, messages, and children, and the Designer is an
org-wide singleton whose activity spans every member's private DM — its
operational reads stay closed. The bootstrap re-applies the blueprint on
every deploy under the policy lock, and the blueprint's `toolPolicy` is
asserted through `assertGenericAgentToolPolicyInput` like user input, so
the vendor config can't smuggle protected keys either.

### D8 — `agent_handoff`: pass the person to the Designer

New builtin, available to every agent by default (`safe: false`) — its
blast radius is a briefing into the requester's own private Designer DM
plus a doorway message in the origin thread. Reworked against both reviews:

- **Args:** `{ target: <global-agent slug>, brief: string }`. v1 targets
  only registry slugs — handoff to arbitrary agents is a different feature
  (the chief-of-staff plan's bounded A2A conversation) and stays out.
- **The requester is the human actor, never `effectiveUserId`.** A
  PA-presence run carries the *owner's* `effectiveUserId` while a different
  member did the asking; keying the DM on the effective user would open (and
  brief) the wrong person's Designer. The tool resolves the **requesting
  human** (`actor.actorType === 'user'` → `actor.actorId`) and refuses when
  the run has none — which also covers unattended, trigger, subtask, and
  agent-authored runs (`payload.interactive === true` required, acting
  membership re-read live).
- **Loop bounds are structural, not asserted.** `agent_handoff` is withheld
  from every `systemSlug` agent (the Designer cannot hand off to itself or
  a future global peer) and from `spawn_subtask` children; and one
  non-expired handoff per `(requesterUserId, targetSlug)` at a time — a
  durable row with a short cooldown, the app-connect-request pattern — so
  retries and continuation runs (new `runId`, same ask) converge on one
  briefing instead of stacking duplicates. Queue idempotency
  `handoff:{originRunId}:{slug}` stays as the crash guard beneath that.
- **The brief does not impersonate the requester.** The integration-handoff
  precedent writes a `role:'user'` message under the person's id — model
  text rendered as their words, editable by them afterwards. The handoff
  brief is instead a **hidden server-authored `system` message** (the
  trigger-kickoff mechanism: starts the run, never renders in the feed,
  never re-enters history) carrying `metadata.agentHandoff = { fromAgentId,
  originChannelId, originThreadId, originRunId, requestedByUserId }`; the
  Designer's own first reply is the visible artifact in the DM.
- **Disclosure travels, and must not silence the Designer.** The brief is
  model text built from the origin run's reads, so its basis is stamped
  from the origin sink remainder — but stamped **after subtracting every
  scope the requester already satisfies** (they heard the brief's content
  in the origin thread). Without the subtraction, a privileged-source brief
  makes the Designer's replies restricted against the only member of the
  DM. A test proves: privileged origin → handoff → the requester still
  reads the Designer's answer; a scope the requester does *not* satisfy
  never reaches the brief in the first place (the origin run could not have
  shown it to them either).
- **The run takes the slot properly.** Delivery goes through
  `claimThreadRunOrPend` exactly like an orchestrator decision — a busy
  Designer DM (open card, running turn) pends the handoff run instead of
  double-running the agent. Orchestrator *judgement* is still skipped;
  slot discipline is not.
- **The origin-thread doorway is a message, not an interactive card.**
  Card `link` blocks require absolute https and card actions carry no
  navigation, and a pressable card would re-enter the wake machinery from
  a run that has ended. The origin thread gets an ordinary agent-authored
  message ("I've handed this to the Agent Designer — continue there")
  whose metadata carries the DM deep link for the client to render as an
  internal navigation affordance, per the navigation framework.
- The routing prompt block stays as designed: one structural line injected
  into every non-designer agent's prompt from the registry ("agent creation
  and redesign are handled by the Agent Designer; use `agent_handoff`") —
  the research-routing precedent; *whether* to hand off is model judgement.

**PA `agent_create` retires from the PA once this ships** (recommended,
phase 4): the PA keeps `agent_list` / `agent_bind_channel` /
`agent_trigger_create` (operational verbs on existing agents) but routes
creation and redesign through handoff, which is the whole isolation story.
If quick one-shot creation from the PA proves to be missed, re-adding the
tool is one registry line — removing a learned behaviour later is harder.

### D9 — One brain, two doorways: unifying the sidebar

The Design Assistant sidebar keeps its transport (in-process SSE, form-filling
tool calls, ephemeral) — it does something the DM cannot: drive the open form
control-by-control. What unifies is the **definition**: one blueprint module
exports the persona and the generated capability catalogue, and both
`api/src/services/designer-prompt.ts` and the worker's Designer prompt build
from it (which is where the api face gets its first live registry read, D5).
The sidebar renders as the Agent Designer — name and avatar from the identity
directory, not a generic "Design Assistant" label. Model resolution is the
blueprint's (D1). Its DuckDuckGo-scrape `web_search` is replaced by the Ledger
Serper route the builtin uses; the direct-scrape path predates the Ledger-only
rule and must not survive unification. And a "Continue in chat" affordance
hands the form draft to the Designer DM as a server-authored context message —
the `agent_handoff` mechanism, not a second one.

A fully thread-backed sidebar (real runs rendered in the rail) is named as the
possible end state but deliberately not built: it would trade the live
form-filling UX for architectural purity the product does not need yet.

## Edit authority — person-owned vs team-owned (decided 2026-09-02)

**Status: implemented 2026-09-02** (phase 0). The prose below is the decision as
made; the built shape and its test coverage are listed under Phases → 0.

Verified: every agent-mutation route (`PUT /api/agents/:id`, both avatar
routes, bindings) gates on `requireOwner` = the **organization owner role**
(`api/src/lib/server-context.ts:267`). A non-owner member cannot edit any
agent today — not even their own private one. This never surfaced because
the people doing the editing were org owners. It is a bug against the
intended model, and both faces of the Designer inherit whatever replaces it,
so the replacement ships first.

The decided model — a fourth **state**, not a fourth tab, derived from the
stewardship fact that already exists:

| Agent | Encoding | Who may edit |
|---|---|---|
| Private | `visibility='private'` (owner required by CHECK) | the live owner, and nobody else — org owners cannot see it, so cannot edit it (the scopes doc's "private beats owner omniscience", unchanged) |
| Workspace, **person-owned** | `ownerUserId` set | the live owner, plus org owners (governance/recovery override — see below) |
| Workspace, **team-owned** | `ownerUserId` null | anyone entitled to the agent (`isAgentAccessibleToActor`), plus org owners |
| Global | `systemManaged` | nobody; blueprint only (refused in the service, not just by route invisibility — D7) |

Stated plainly, because it is a deliberate widening: **team-owned means any
member who can see the agent through a channel they can read may rewrite
its prompt, model, tools, and limits.** That is what "team-owned" is for;
placement (`agent_bind_channel`) stays behind its stricter four gates, and
the asymmetry is intentional — editing improves the shared agent in place,
binding changes who is exposed to it.

"Edit" is a **field-sensitive** contract, not a whole-body switch (review
finding: `UpdateAgentBodySchema` carries `ownerUserId` and `todosEnabled`,
so one predicate over the whole PUT would let any entitled member claim or
transfer a team-owned agent and toggle owner-only to-dos):

- **Edit fields** — name, role, system prompt, model/provider, effort, run
  limits, ordinary tool-policy keys, avatar: gated by `canEditAgent`.
- **Ownership transitions** — transfer, release-to-team (`→ null`): the
  current owner or an org owner only, never mere edit entitlement;
  `agent.owner_changed` audits. Claiming a team-owned agent (null → self)
  stays org-owner-only in v1 — an edit helps everyone, a claim locks
  everyone else out.
- **`todosEnabled`** — keeps its org-owner gate (it authorizes
  trigger-driven work, a different blast radius).
- **Not covered at all** — bindings (own gates), explicit-grant keys
  (`assertGenericAgentToolPolicyInput` stands for every editor),
  visibility (immutable).

The service (`updateAgentRecord`) therefore learns the **actor**: today the
route passes the whole body to an actor-less service, which cannot express
field-sensitive refusals. `canEditAgent(actor, agent)` +
`assertAgentFieldAuthority(actor, agent, patch)` live in
`@nessie/workspace-admin`, replace `requireOwner` at PUT + both avatar
routes, and are consumed verbatim by `agent_update` /
`agent_avatar_update` — routes and chat cannot disagree by construction.
Refusals are worded per state ("this agent is owned by <name>; ask them or
an org owner").

Other decisions:

- **Private agents become editable by their owner** — the headline fix.
- **Legacy unowned rows become team-owned.** Pre-stewardship agents have
  `ownerUserId = null` and no recorded author; "anyone entitled may edit" is the
  honest reading, and it is a widening only relative to a gate that was itself
  wrong. The people-tree's "Unowned" bucket renames to "Team-owned".
- **Org-owner override stays on workspace agents**, both flavours: "only I can
  edit" is with respect to other members, and without it a person-owned agent
  whose owner is deactivated has no editor at all. Private agents remain the
  sanctioned exception.
- **"Promote" (private → workspace publish) does not exist yet** — visibility is
  immutable in v1 and no route or form writes it. When publish lands, ownership
  survives it, producing exactly the asked-for person-owned workspace agent;
  nothing here depends on it shipping first.
- **Admin surface:** the detail header states the state ("Owned by <person>" /
  "Team-owned") with the release/transfer control for whoever may use it; the
  scope tabs are untouched. `docs/plans/2026-08-29-people-and-their-agents.md`
  carries the rule that ownership now confers edit authority and that a null
  owner is a deliberate state, not missing history.

## The parameter map (what the Designer knows and may drive)

"May edit" below = the `canEditAgent` predicate from "Edit authority".

| Parameter | Set by | Designer verb | Notes |
|---|---|---|---|
| `name`, `role` | any member at create; may-edit at update | `agent_create` / `agent_update` | |
| `systemPrompt` | same | same | the Designer's main craft output |
| `visibility` | create only | `agent_create` | immutable after; private ⇒ owner-only home DM, unbindable, untransferable |
| `provider` + `model` | member at create; may-edit at update | same | exact pair from `listLedgerAgentModels`; needs linked UOA identity |
| `effort` | same | same | `low\|medium\|high\|xhigh` → provider `reasoning_effort` only |
| `runLimits` | same | same | 5 optional caps over the deployment backstop |
| `todosEnabled` | org owner only | `agent_create`/`agent_update`, refused in words otherwise | disabling checks trigger references |
| `toolPolicy` (ordinary keys) | may-edit | same, via merge | deny-mode builtins, allow-mode connectors |
| `toolPolicy` (explicit-grant keys) | owner surfaces only | **never** — named in words, pointed at Apps/Integrations | `assertGenericAgentToolPolicyInput` is the law |
| `avatarAttachmentId` / `avatarBackgroundColor` | may-edit | `agent_avatar_update`; generation shared with create (D4) | |
| `ownerUserId` | create: forced to actor; update: owner/org-owner transfer **or release to team** (`null`) — never mere may-edit | `agent_update` (refused for private agents) | null = team-owned: anyone entitled may edit |
| bindings | org owner + policy + membership | `agent_bind_channel` | PA/system channels + private agents refused structurally |
| triggers | owner, UOA identity required for schedules | `agent_trigger_create` | `systemSlug` targets refused (D2) |
| `parentAgentId`, `agentKind`, `systemManaged`, `surfacePolicy`, `delegationMode`, `executionMode`, `routingProfileId`, `systemSlug` | server/bootstrap only | **never** | the Designer states this when asked |

## The tool catalogue (what the Designer can offer an agent)

Deliberately not written out here. The Designer's knowledge of what an agent can
be given is the **generated D5 block**, rendered from
`BUILTIN_TOOL_DEFINITIONS` plus the organisation's live registry rows through
`loadAgentToolCatalog`, and a hand-kept list beside it would be wrong within a
release. The catalogue's three groups are togglable tools (built-ins in
deny-mode, connectors in allow-mode keyed by registry uuid), tools reserved for
Nessie's built-in specialists, and explicit-grant tools the owner surfaces
grant — the Designer names the last two rather than pretending they do not
exist.

## Security invariants

1. **Route-mirroring, exactly.** Every Designer tool calls the shared
   `@nessie/workspace-admin` function its route calls, with the route's
   authorization re-derived from the live membership row at call time.
   Owner-gated verbs stay visible and refuse in words.
2. **No self-granting, no self-editing.** The Designer cannot write
   protected policy keys, cannot touch grants, cannot widen an app install,
   cannot create system-managed rows, and cannot edit its own row — all
   enforced at existing chokepoints (including the new service-level
   `systemManaged` refusal, D7), not by prompt.
3. **Identity is structural and interactive.** `effectiveUserId` comes from
   the single-member DM stamp (DB-enforced membership), never from content;
   identity-delegated tools additionally require an interactive human turn,
   so no unattended run ever wields them.
4. **Delegated reads feed the sink; the handoff carries provenance.** Every
   read the Designer performs as the person stamps its scopes; the handoff
   brief's basis is the origin remainder minus requester-satisfied scopes;
   unattended and presence-effective identities cannot hand off.
5. **The blueprint is config, not authority.** Bootstrap policy passes the
   same `assertGenericAgentToolPolicyInput` as user input.
6. **No new hierarchy, no UOA duplication.** Per-org rows; the
   `systemSlug` CHECK requires `organizationId`, so cross-org rows are a
   database impossibility, not a convention.

## Phases

0. **Edit authority — implemented 2026-09-02.** `canEditAgent` /
   `resolveAgentEditAuthority` / `assertAgentEditAuthority` /
   `assertAgentFieldAuthority` live in
   `packages/workspace-admin/src/agent-edit-authority.ts`. `PUT
   /api/agents/:agentId`, `PATCH …/avatar` and `POST …/avatar/generate` no
   longer call `requireOwner`; the acting person is threaded into
   `updateAgentRecord` and `updateAgentAvatar`, so the field-sensitive refusals
   live in the services rather than only at the routes, and the PUT route asks
   before the billed Ledger model-catalogue call. `systemManaged` is refused
   explicitly in both services (`SYSTEM_AGENT_IMMUTABLE`) instead of relying on
   route invisibility. Release-to-team rides the existing `ownerUserId` transfer
   path and keeps emitting `agent.owner_changed`; private agents keep
   `AGENT_PRIVATE_TRANSFER_UNSUPPORTED`. Every refusal has its own 403 code
   (`AGENT_EDIT_PRIVATE_OWNER_ONLY`, `AGENT_EDIT_OWNER_ONLY`,
   `AGENT_EDIT_NOT_ENTITLED`, `AGENT_EDIT_MEMBERSHIP_INACTIVE`,
   `AGENT_OWNERSHIP_CHANGE_FORBIDDEN`, `AGENT_TODOS_OWNER_REQUIRED`,
   `SYSTEM_AGENT_IMMUTABLE`). The admin mirrors the rule in one place
   (`admin/src/components/features/agents/agent-edit-authority.ts`): the detail
   page, its tabs, the Tools editor, the avatar controls, the drawer and the
   channel agent panel all gate on `useCanEditAgent`; the header carries an
   `AgentOwnershipState` line with a confirmed Release-to-team /
   Take-ownership control; the people-tree bucket is renamed "Team-owned".
   Tests: `api/test/agent-edit-authority.test.ts` (DB-backed — every arm of the
   table above, transfer/claim/`todosEnabled` refused for a mere editor, the
   org-owner override, the system-managed refusal in both services, and the
   protected-key refusal unchanged for every editor), route cases in
   `api/test/agent-policy-routes.test.ts`, and the mirrored client predicate in
   `admin/test/agent-edit-authority.test.ts`. `AGENTS.md` and
   `docs/plans/2026-08-29-people-and-their-agents.md` carry the rule.
1. **Foundation — implemented 2026-09-02.** Migrations
   `20260902190000_global_agent_channel_type` (the `system_agent` enum value,
   alone in its own file because PostgreSQL forbids using a new enum value in
   the transaction that adds it) and `20260902190100_global_agent_foundation`
   (`Agent.systemSlug` + `@@unique([organizationId, systemSlug])` + the
   org-not-null CHECK; the `gagent:` arm on
   `channels_personal_assistant_surface_chk`, restating all four pre-existing
   arms; the `gagent:` arm on `assert_private_agent_home_members`, owner at
   segment 4). Blueprint registry + `ensureGlobalAgent` /
   `ensureGlobalAgentChannel` / `ensureGlobalAgentsForUser` in
   `@nessie/workspace-admin` (`global-agent-blueprints.ts`,
   `global-agent-bootstrap.ts`), re-exported by
   `api/src/services/global-agents.ts`; the Agent Designer blueprint with a
   short persona and a deny-mode `{delegate,spawn_subtask}` narrowing;
   per-user home DM in a hidden `Global Agent System` team with the binding
   written directly; system-channel binding refusal widened to any non-null
   `systemChannelType` (chokepoint, both routes, the PA tool) and
   `canManageChannel` refusing system channels; `createAgentTrigger` refusing a
   `systemSlug` target; `effectiveUserId = poster` and the channel-only
   realtime scope extended to `system_agent` DMs via
   `isDelegatedSystemDmChannelType`; the orchestrator fast-path generalised to
   `resolveSystemDmDecisions` / `isSingleAgentSystemDm`;
   `assertGlobalAgentRunPlacement` at run start with its own classified
   failure reason; `listAgentsForUser`'s system arm no longer channel-gated;
   admin `isGlobalAgentChannel`, the `useSidebarDms` branch, the
   `AgentIdentityProvider` reading `scope=all`, and the ChannelsPage
   responding-agent predicate. Bootstrap runs beside the PA's at login
   (`auth-login` ×2, `auth-core`) and user provisioning (`users.ts`), wrapped
   best-effort so a blueprint fault can never fail a login.

   Deferred out of phase 1 and picked up later: the identity-delegated tools
   and the generated catalogue (D3/D5, phase 2a/2b) and the read-only detail
   view (phase 4). Still deferred: no avatar *image* at bootstrap (a billed
   call), only a stable `avatarBackgroundColor`.
2. **The Designer at work.**
   **2a — identity-delegation backbone, implemented 2026-09-02.** One shared
   predicate, `runDelegatesToRequestingPerson`
   (`worker/src/run/delegated-identity.ts`): the PA inside its own DM, or a
   `home: 'per_user_dm'` blueprint inside its own home DM, derived from agent
   kind + `systemSlug` → blueprint + the destination's `systemChannelType` and
   `dmKey`. Beside it, `agentActsAsRequestingPerson` (the identity half, no
   surface condition), `isGlobalAgentHomeSurface` (the surface half, now shared
   with `assertGlobalAgentRunPlacement`), `isDelegatedSystemDmChannelType` (the
   channel-type-only half, mirroring the api helper, now backing
   `isSingleAgentSystemDm` and `buildRealtimeScopesForChannel`),
   `resolveDelegatedRequesterUserId` and `resolveIdentityDelegatedToolIds`.
   The `personalAssistantOnly` gate takes exactly one new arm — blueprint
   declares the id AND own home DM AND `payload.interactive === true` with a
   live human requester equal to the stamped `effectiveUserId` — resolved once
   at run setup and threaded into **both** `resolveAgentTools` (omit, never
   offer-then-deny) and `authorizeToolCall`, never into a delegate sub-agent.
   The interactive arm is the second of two locks with phase 1's
   `createAgentTrigger` refusal: that one governs what can be created, this one
   what may be exercised. Re-keyed sites: `execute/memory.ts` (containment
   exemption + scope-resolution mode) and `execute/scopes.ts` (org/agent lanes
   withheld from a `system_agent` DM, matching the orchestrator's already-general
   `isSingleAgentSystemDm`). Deliberately still PA-keyed, each with a comment
   saying why: `execute/completion.ts` (inside its own DM the reply stays
   assistant-authored — a design conversation must render as the Designer's
   words), `control/trigger-run.ts` and `schedule_task`'s
   `isDelegatingPersonalAssistant` (both waive a *binding* check, and a global
   agent is genuinely bound to exactly one channel), and
   `resolveAccessibleChannelIds` (a global agent falls to `user_shared`, which
   is narrower, never wider — widening belongs with the tools that need it).
   `pa-tools/access.ts`'s `resolveEffectiveUserId` / `requireActingUserId` /
   `resolveActingMember` were verified correct unchanged: they read
   `effectiveUserId`, which the message-create route stamps for every delegated
   system DM. Delegated reads now feed the sink —
   `recordChannelDirectoryRead` on `channel_list` / `channel_find` and on
   `agent_list`'s bound-channel labels, `recordVisibleAgentRead` for private
   agents (workspace rows deliberately unstamped: `agent:<id>` is the shared
   visibility predicate and an org owner's list exceeds it, so stamping would
   withhold the Designer's answer from the only reader of the DM). The
   blueprint declares its five identity tools in `identityToolIds` and states
   them in `toolPolicy`, and its prompt no longer says it can only advise.
   **2b — tools, catalogue and persona, implemented 2026-09-02.**

   - **Four new builtins**, all `personalAssistantOnly` and listed in the
     blueprint's `identityToolIds` + `toolPolicy`, so 2a's gate arm admits them
     in the Designer's own home DM on an interactive turn (until it merges they
     are simply denied — the blueprint declares them, nothing else changes):
     `agent_read`, `agent_update`, `agent_tool_catalog`, `agent_avatar_update`
     (`packages/runtime/src/builtin-agent-tools.ts`; handlers in
     `worker/src/run/pa-tools/agent-config.ts`; dispatch in
     `worker/src/run/tools.ts`).
   - **`readAgentRecordForActor`** (`packages/workspace-admin/src/agent-read.ts`)
     applies exactly the list entitlement — `buildAgentEntitlementWhere` was
     factored OUT of `listAgentsForUser` so one composition serves both, never a
     second `where` beside it — and returns the same `AgentRecord`. A
     `systemManaged` target returns `record: null` plus the config-only
     `AgentConfigProjection` (name, role, prompt, policy, model, effort, limits,
     owner, visibility), which is what the phase-4 read-only detail view will
     render. `agent_read` stamps `{scopeType:'agent'}` into the run's
     `ConsumedSourceSink`.
   - **`agent_update`** calls the shared `updateAgentRecord`, which MOVED to
     `packages/workspace-admin/src/agent-update.ts` (with `updateAgentAvatar`)
     because `api/src/services/*` is unreachable from the worker;
     `api/src/services/agent-management.ts` and `agent-avatars.ts` re-export.
     Phase 0's `canEditAgent` / `assertAgentFieldAuthority` therefore decide
     every refusal for chat and form alike; the tool additionally explains a
     `systemManaged` target in words before the service refuses it, and mirrors
     the PUT route's `assertAgentModelSelection` on the resulting model pair.
   - **`agent_tool_catalog`** reads
     `loadAgentToolCatalog` (`packages/workspace-admin/src/agent-tool-catalog.ts`)
     — a new **member-safe** projection; `GET /api/mcp/tools` stays owner-only.
     Builtins deny-mode from `BUILTIN_TOOL_DEFINITIONS` (minus any the
     organization disabled in its registry), the organization's live active
     non-protected connector rows allow-mode keyed by registry uuid, to-do
     gating flagged, and `personalAssistantOnly` / `requiresExplicitGrant` tools
     NAMED in a `restricted` list with where they are granted. Entries are
     assembled field-by-field from a narrow selection, so no credential,
     endpoint, auth block, transport config or grant state can be emitted.
   - **One avatar seam.** `generateAgentAvatar` moved to
     `packages/workspace-admin/src/agent-avatar-generation.ts` and gained
     `generateAvatarForNewAgent`, called by both `POST /api/agents` and the PA
     `agent_create` tool, so a chat-created agent is no longer the only faceless
     one. It never throws: a failed or unconfigured generation reports through
     `onFailure` and the agent is created without a picture (the create route
     used to 503 instead; `POST …/avatar/generate` keeps its loud error).
   - **The generated capability catalogue (D5)** lives in
     `worker/src/run/execute/global-agent-catalogue.ts` and renders from live
     sources only: the contracts (`AgentVisibilitySchema`, `AgentEffortSchema`,
     `AgentRunLimitsSchema.shape`, `AgentTriggerTypeSchema`), the tool catalogue
     above, and `listLedgerAgentModels` (best-effort — an unreadable catalogue
     says so rather than guessing). It is assembled only for a run whose agent
     resolves a blueprint, and wired at ONE call site in
     `worker/src/run/execute/run-job.ts` immediately after
     `prepareRunExecution`, riding as its own `system` message after the
     cache-stable anchor (the memory/checkpoint injection pattern) rather than
     inside `buildModelPrompt`, whose only call site is `run-setup.ts`.
   - **Persona (D6)** replaces the phase-1 placeholder: understand the work
     first, ask the next real question rather than a questionnaire, propose a
     complete draft early, say what was created and where it lives, cards
     without `wait` by default with `wait` reserved for a must-answer step and
     always with an expiry. No scripted flows and no example questions.
   - Tests: `api/test/agent-designer-reads.test.ts` (DB — entitlement arms, the
     config-only system projection, cross-org refusal, a newly inserted
     registry row appearing, the leak-proof shape asserted on the projection's
     field set, an org-disabled builtin leaving),
     `worker/test/agent-config-tools.test.ts` (DB — the four handlers end to
     end, every `canEditAgent` refusal inherited, the `agent:` sink stamp, a
     deactivated member refused),
     `worker/src/run/execute/global-agent-catalogue.test.ts` (the block renders
     from live definitions), `packages/workspace-admin/test/agent-avatar-seam.test.ts`.

   Still 2a's: the D3 gate arm, the interactive-turn condition, and the
   delegation-predicate re-key. Deferred with phase 3/4: `agent_handoff`, the
   sidebar unification, and the read-only global detail view that renders the
   config-only projection.
3. **Handoff — implemented 2026-09-02.** `agent_handoff`
   (`packages/runtime/src/builtin-handoff-tools.ts` +
   `worker/src/run/pa-tools/agent-handoff.ts`), default-on for every agent,
   `{ target: <registry slug>, brief }`. Migration
   `20260902200000_agent_handoff_requests` adds `AgentHandoffRequest`
   (`(requester, targetSlug)` convergence under a `pg_advisory_xact_lock`, no
   unique constraint so superseded rows are retained; 10-minute cooldown,
   60-minute row expiry). The requester is the actor, never `effectiveUserId`,
   with `interactive === true` and a live `OrganizationMember` re-read — one
   condition refusing unattended, trigger, subtask and agent-authored runs. The
   loop bound is structural in `authorizeToolCall`: the tool is omitted from
   any `systemSlug` agent's schema array (`agentSystemSlug` threaded from
   `context.agent.systemSlug` at both `resolveAgentTools` and the per-call
   gate) and from `spawn_subtask` children beside `spawn_subtask` itself; the
   queue key `handoff:{originRunId}:{slug}` is the crash guard beneath the row.
   The brief is a hidden `system` message carrying
   `metadata.agentHandoff`, delivered through `claimThreadRunOrPend` with
   `replyPlacement: 'channel'` fused to it; its basis is
   `computeReplyBasis` against the DM then `subtractImpliedScopes` against the
   requester's live disclosure viewer, and `run-job.ts` now feeds the trigger
   message's basis into the run's sink so a restricted brief cannot launder
   itself out through an empty-basis reply. The origin doorway is an ordinary
   agent message carrying `metadata.agentHandoffDoorway`, rendered by
   `admin/src/components/features/channels/AgentHandoffDoorway.tsx`. The
   routing block (`worker/src/run/execute/handoff-routing.ts`) renders from the
   registry's new `handoffSummary` field, so a second global agent is in every
   agent's prompt the deploy it ships. Tests:
   `worker/test/db/agent-handoff.test.ts` (one brief + one doorway + one run;
   cooldown convergence with no duplicate; unattended/non-interactive/
   agent-authored/unknown-target refusals; a PA-presence run opening the
   *asking* member's DM and never the effective user's; a busy home DM pending
   instead of double-running; a privileged-origin handoff leaving the brief
   basis-free and the Designer readable by its one member; the bootstrapped
   Designer row having no `agent_handoff`), plus
   `worker/src/run/handoff-bounds.test.ts` and
   `worker/src/run/pa-tools/handoff-basis.test.ts`.
4. **Consolidation — implemented 2026-09-02.**

   - **Design verbs retired from the PA.** A new
     `BuiltinToolDefinition.identityDelegatedOnly` narrows
     `personalAssistantOnly` to the identity-delegated arm alone: the tool stays
     in the registry (the Designer needs it) but the PA's `agentKind` arm no
     longer admits it, so it is *omitted* from the PA's schema array rather than
     offered and denied. It carries `agent_create`, `agent_read`,
     `agent_update`, `agent_tool_catalog` and `agent_avatar_update` — creation
     **and redesign**, per D8 — while `agent_list`, `agent_bind_channel`,
     `agent_trigger_create` and `channel_create` stay with the PA. Its prompt
     needed no rewrite: the phase-3 routing block already says agent design
     belongs to the Designer and `agent_handoff` is how one gets there.
     `loadAgentToolCatalog` gained a third restriction reason
     (`built_in_specialist_only`) so the Designer never calls a tool it alone
     holds "Personal Assistant only".
   - **One brain, two doorways.** `buildGlobalAgentCatalogueBlock` moved to
     `@nessie/workspace-admin` and the API's `buildDesignerSystemPrompt` now
     renders the blueprint's own persona plus that generated block; the
     hand-written "expert AI agent designer" principles are gone. The api face
     got its first live registry read (`loadAgentToolCatalog`, server-side) and
     `availableTools` was **removed from `DesignerChatBodySchema`** — the browser
     no longer tells the server what this workspace has. The block's closing
     instruction is a `writeSurface` (`agent_tools` | `designer_form` |
     `read_only`), because the sidebar drives an unsaved form and must never
     claim it created an agent. Model resolution is `resolveGlobalAgentModel`.
   - **Ledger search, no scraping.** `runWebSearch` moved to `@nessie/runtime`;
     `api/src/services/designer.ts` calls it with the signed identity headers
     and `LEDGER_PROXY_TOKEN`, and the DuckDuckGo HTML scrape is deleted. An
     unconfigured deployment says so in the prompt and returns nothing.
   - **Identity and "Continue in chat".** `AgentRecord.systemSlug` is now on the
     wire (read-only, server-written), so the sidebar resolves the Designer
     structurally and renders its name and portrait through the identity
     directory. `POST /api/designer/continue-in-chat` hands the open draft to the
     person's own Designer DM through the **shared** `deliverGlobalAgentBrief` —
     the hidden `system` message, `claimThreadRunOrPend`,
     `replyPlacement: 'channel'` and the idempotency key that `agent_handoff`
     was refactored onto in the same change, so there is one mechanism rather
     than two. It takes the queue functions as parameters
     (`AgentTodoRunQueue`'s precedent) because this package is loaded from
     `dist` by processes that resolve `@nessie/db` differently.
   - **The read-only detail view (D7).** Shipped as a bespoke
     `SystemAgentConfigPanel` over a narrow `GET /api/agents/:agentId/config`
     read; **both were deleted on 2026-09-02** as a Rule zero #4 violation — a
     second implementation of a view that already existed. A `systemManaged`
     agent now renders the ordinary detail surface with the designer form
     disabled and only the Edit + Tools tabs, seeded from the entitled agent
     list. `isAgentAccessibleToActor` is still untouched, so status, activity,
     messages and children still 404. See `docs/global-agents.md`.
   - Tests: `api/test/designer-continue-in-chat.test.ts` (DB — the hidden
     `system` brief, one run, the `gagent:` DM shape, convergence on a second
     click, deactivated-member and unknown-slug refusals), the
     `readAgentRecordForActor` entitlement cases in
     `api/test/agent-designer-reads.test.ts`, the retirement and the Designer's
     continued access in `worker/test/identity-delegation.test.ts`, and the
     rewritten designer prompt/service suites (the catalogue reaches the prompt
     from the database, not the browser).

Every phase landed with its admin surface (Rule zero), its docs, and DB-backed
tests: bootstrap idempotency and policy merge, the CHECK arms (agents, channels,
home membership), DM single-membership and single-binding, the D3 gate (allowed
in the home DM on an interactive turn, denied everywhere else and for ordinary
shared agents), handoff (cooldown convergence, basis subtraction with a
readable-reply assertion, unattended and presence-effective refusal, slot
pend), and `agent_update` mirroring every `canEditAgent` refusal. Fixtures
include non-English, slang and misspelled inputs, per the
intent-is-model-judged rule.

## Cross-model review (2026-09-02)

Kimix (14 findings) and Codex Sol (22 findings) reviewed the same revision
independently; both verdicts were "not implementation-ready", and every adopted
claim was re-verified against code before the revision that answered it. Each
finding below is now built, and the design decision it changed is stated in the
D-section that owns it — this is the record of *why* those sections say what
they say.

**Converged:** D3's plumbing was under-specified (surface facts never reached
`authorizeToolCall`, and the toolset must omit rather than offer-then-deny);
the sidebar/admin work was understated (`useSidebarDms`, the DM predicates and
participants, not just the identity directory); `agent_read` cited a
nonexistent route and contradicted the read-only detail view (resolved as the
config-only projection); edit authority needed field-sensitive enforcement,
because the PUT body carries `ownerUserId` and `todosEnabled`; the handoff
needed a real loop bound (a per-requester cooldown row, withheld from global
agents and subtask children).

**Kimix:** the channel-surface CHECK violation twin; the five `agentKind`-keyed
delegation sites re-keyed onto one predicate; delegated reads feeding the
disclosure sink; the handoff-basis subtraction, without which the Designer is
silenced in its own DM; the `systemSlug` CHECK requiring `organizationId`; the
api face's missing registry access (D5, delivered in phase 4).

**Sol:** unattended trigger runs would have wielded identity tools (hence the
interactive arm and no self-triggers); nothing prevented a second agent binding
into a system DM, nor rename/archive of one; `wait: true` holds the thread
slot, so "answer in chat instead" required the no-wait default;
`updateAgentRecord` did not refuse existing system rows; "promote is the
existing publish act" was false, visibility being immutable; a PA-presence
handoff would have opened the PA *owner's* DM rather than the asker's; the
handoff bypassed `claimThreadRunOrPend` and impersonated the requester with an
editable `role:'user'` message; the origin "link card" could not be expressed by
the card contract; `agent_create` never generated avatars; the general
`agent_update` conflicted with conversational-setup (explicit supersession); and
the blueprint had no model fields.

**Noted, not blocking:** message edit does not refuse
`agentCardResponse`-stamped rows (filed as an adjacent defect below).

## Open questions

Two of the original three are answered by the build: `gagent:` DM keys stay
org-scoped with no UOA team segment (creation acts org-wide), and bootstrap runs
at **login**, beside the Personal Assistant's, so the sidebar DM row is simply
there. The one still open is whether entitled members may *claim* a team-owned
agent — v1 says no (org owners only): an edit helps everyone, a claim locks
everyone else out. Revisit if release/claim churn shows up in real use. Two
earlier questions were resolved in the design itself: the `PUT /api/agents/:id`
owner arm became the "Edit authority" model, and model resolution is D1/D9's
blueprint pin → `NESSIE_DESIGNER_MODEL` → organisation default.

## Adjacent defects noticed while mapping (filed separately)

**Fixed along the way:** `createExternalAgentData` wrote a tuple
`agents_system_managed_invariants_chk` forbade and a DM key
`channels_personal_assistant_surface_chk` rejected — both repaired by migration
`20260902170000_external_agent_surface_invariants`, with
`api/test/external-agent-bootstrap-db.test.ts` now driving the real service
against Postgres, because the cast fake could see neither CHECK. That is the
`extagent:` lesson D2 cites. Also: `POST /api/designer/chat` dropped
`pageContext` before the prompt; `PA_PRESENCE_PRIVATE_READ_TOOL_IDS` carried a
dead `message_post` entry (removed, with a test asserting every id resolves);
`CreateAgentBodySchema` accepted a `routingProfileId` the route discarded
(removed rather than wired — it is server/bootstrap-only).

**Still open:**

- The `pa:%` arm of `channels_personal_assistant_surface_chk` carries no
  `system_channel_type` condition (it predates the type-keyed arms), so a row
  claiming `system_channel_type = 'system_agent'` with a `pa:` key is still
  admitted. Nothing can reach that shape today — bootstrap only writes
  `gagent:` keys and `assertGlobalAgentRunPlacement` requires that prefix — and
  tightening the legacy arm wants its own migration plus a survey of existing
  rows.
- `updateMessage` (`api/src/services/messages.ts`) does not refuse editing a
  message stamped `agentCardResponse`, though the cards spec says a card
  response is immutable — a resolved card's decision text can be edited into
  disagreement with the card's authoritative state.

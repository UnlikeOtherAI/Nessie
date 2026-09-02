# The Agent Designer — the first global agent

**Status:** plan; no implementation claimed.
**Date:** 2026-09-02
**Related:**
[2026-08-30-agent-scopes-personal-team-global.md](2026-08-30-agent-scopes-personal-team-global.md)
(global agents = app-provided, per-org bootstrap rows; reachability was
deliberately left as "a later phase" — this plan is that phase, for one agent),
[2026-08-31-conversational-agent-setup/overview.md](2026-08-31-conversational-agent-setup/overview.md)
(the chat-first creation grammar and the Design Assistant sidebar),
[2026-08-29-people-and-their-agents.md](2026-08-29-people-and-their-agents.md),
[2026-09-01-agent-chat-cards.md](2026-09-01-agent-chat-cards.md).

## Outcome

Nessie ships its first **global agent**: the **Agent Designer**. It is
hard-coded in the deployment (a code blueprint, instantiated per organisation
by bootstrap, exactly the Personal Assistant / Librarian pattern), not
editable by anyone, and it owns one job: talking to a person about the agent
they want — what work it should do, whether there are specialist tasks, what
it needs access to — and then creating or reshaping that agent through the
same chokepoints the Agent Designer page uses. It collects structured answers
with interactive cards (a person can press/fill the card **or** just answer
in chat — both work, because a card press is an ordinary message), and it is
the one place in the product that holds the complete, generated catalogue of
every agent parameter and every tool.

Every other agent knows, structurally, that agent design is the Agent
Designer's job. When a person asks their PA or any bound agent to "create an
agent that does X", that agent answers in its own words and **hands the
conversation off** — a new `agent_handoff` builtin that opens (or continues)
the person's private Agent Designer DM with a server-authored briefing, and
leaves a link card behind in the original conversation. The big
design-catalogue context lives only in the Designer's own runs; no other
agent carries it.

The existing Design Assistant sidebar on the Agent Designer *page* becomes a
second face of the same agent: one blueprint module supplies the persona,
capability catalogue, and tool vocabulary to both the page's form-filling
transport and the chat agent, so there is one brain with two doorways rather
than two brains.

## What exists today (verified 2026-09-02)

- **The global tier exists but is unreachable.** DB CHECK
  `agents_system_managed_invariants_chk` admits
  `(systemManaged=true, shared, shared, none)`; the Librarian and
  external-agent products use it. But `bindAgentToChannel` refuses every
  `systemManaged` agent, `isAgentVisibleToUser` hard-codes
  `systemManaged: false` (list-only, no detail), and an *unbound* global
  agent is invisible to everyone (`listAgentsForUser`'s
  `includeSystemManaged` arm requires a binding into a visible channel).
  The scopes doc names the fixes; none is built.
- **Bootstrap precedent is solid.** `ensurePersonalAssistantAgent` /
  `ensureLibrarianAgent` / `ensureExternalAgent`: advisory lock →
  find-by-discriminator → create-or-update-in-place, config merged under the
  per-agent policy lock so a targeted grant committed in between is never
  clobbered. Discriminators are ad-hoc, though — the Librarian is keyed by
  **name**, which is fragile.
- **Per-user system DM precedent is solid.** PA (`pa:{org}:{user}`,
  `systemChannelType='personal_assistant'`, membership forcibly reduced to
  one) and external agents (`extagent:{slug}:{org}:{user}:{team}`). The PA
  DM is where `effectiveUserId = poster` is stamped
  (`thread-message-create.ts`) — safe exactly because the DM has one member —
  and where the orchestrator's structural fast-path replies without an
  engagement judgement.
- **The provisioning tools exist, PA-only.** `agent_list`, `agent_create`,
  `agent_bind_channel`, `agent_trigger_create`, `channel_create` in
  `worker/src/run/pa-tools/provisioning.ts`, each mirroring one route's
  authorization and calling the same `@nessie/workspace-admin` function.
  There is deliberately **no** `agent_update` tool and no `agent_read`
  detail tool today.
- **Cards do forms.** `card_post` (default-on for every agent) carries
  `input` blocks (`text | textarea | number | select | checkbox | date`),
  up to 4 actions, `wait: true` suspends via the approval machinery into
  `waiting_input`, and a press is a real `user` message read structurally.
- **The Design Assistant sidebar is a second brain.** `POST /api/designer/chat`
  is a stateless in-process SSE loop (budget-gated, `NESSIE_DESIGNER_MODEL`)
  with its own prompt (`api/src/services/designer-prompt.ts`), its own tool
  vocabulary (`set_name`, `set_role`, `set_system_prompt`, `set_model`,
  `toggle_tool`, `batch_toggle_tools`, `web_search`), its own DuckDuckGo
  scraper for search, and no persistence — the conversation dies with the
  React component.
- **No conversation-transfer primitive exists.** Agent-to-agent reach today
  is: the orchestrator (guarded by `triggerIsHuman` — agent-authored posts
  never trigger engagement), the PA's `send_message` (posts as the owner),
  the owner-only mailbox (one-shot dispatch to a *bound* agent, no
  agent-facing writer), and the server-authored integration handoff
  (`integrationLaunch` metadata + direct `enqueueRunExecution`, skipping
  the orchestrator). The integration handoff is the pattern to reuse.

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
  effort: AgentEffort               // 'medium'
  runLimits?: AgentRunLimits
  home: 'per_user_dm'               // v1: DM-homed only
}
```

New column **`Agent.systemSlug String?`**, unique on
`(organizationId, systemSlug)`, CHECK `systemSlug IS NOT NULL ⇒
systemManaged`. This is the discriminator the ensure function keys on —
replacing name-keying (the Librarian's fragility) for new global agents, and
giving the worker a structural way to know *which* global agent a run
belongs to (D3, D8). Backfilling PA/Librarian/external agents onto it is a
follow-up, not required here.

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
never a widened pattern. Three things hang off the channel type, all
mirroring the PA DM:

- `thread-message-create.ts` stamps `effectiveUserId = poster` (safe: one
  member), so the Designer acts as the person it is talking to.
- The orchestrator's structural fast-path replies to every user turn without
  an engagement judgement (generalize `resolvePersonalAssistantDecisions`
  to single-member system DMs, keyed on the channel type — never on content).
- The worker asserts at run start that a `systemSlug` agent with
  `home: 'per_user_dm'` only ever runs in its own DM or its own trigger
  threads (the private-agent run-start assertion, reused).

Why a DM and not presence in the asking channel: the person said it
themselves — the design catalogue is big, and creation is a focused,
personal conversation. Isolation is the point. General bindability of global
agents stays with the scopes doc's later phase; this plan does not need it.

**Doorways (Rule zero):** the DM appears in the sidebar DMs list (the
external-agent precedent in `useSidebarDms`); the Agents page Global tab
lists the Designer even when unbound (adopt the scopes doc's
`{ systemManaged: true }` list branch); the Agent Designer page links "Chat
with the Agent Designer"; and `agent_handoff` (D8) is the in-context
doorway from every other conversation. `AgentIdentityProvider` learns to
resolve global agents (today it only merges the PA), so the Designer never
renders as a `⚡`.

### D3 — Identity-delegated tools: generalize the `personalAssistantOnly` gate

The Designer needs `agent_create`, `agent_bind_channel`,
`agent_trigger_create`, `channel_create`, `agent_list` — all flagged
`personalAssistantOnly`, gated on `agentKind === 'personal_assistant'`.
Rather than fork designer-specific copies (the eighth look-alike), the gate
in `authorizeToolCall` widens by one structural arm:

> a `personalAssistantOnly` tool is allowed when `agentKind` is PA **or**
> the run's agent has a `systemSlug` whose blueprint lists the tool in
> `identityToolIds` **and** the run is on the agent's own single-member DM
> surface.

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
| `agent_create` | the create chokepoint (`createAgentRecord`), incl. private agents + home DM |
| `agent_bind_channel` | place the new agent (all four route gates) |
| `agent_trigger_create` | schedules, with the UOA-identity refusal intact |
| `channel_create` | "it needs its own channel" |
| `card_post` | forms and choices (D6) |
| `web_search`, `web_fetch` | research a service/domain before writing the prompt |
| `people_search`, `channel_find`, `channel_list` | resolve names the person uses |
| `document_read`, `kb_search`, `kb_page_read` | ground a prompt in existing material when asked |

New builtins (each mirrors one route's authorization — no weaker, no
stronger — with the shared function in `@nessie/workspace-admin` and the api
service re-exporting; a tool that takes an id ships with the read that
resolves it):

| Tool | Mirrors | Notes |
|---|---|---|
| `agent_read` | `GET /api/agents/:id` entitlement (`isAgentAccessibleToActor` + visibility) | full record (prompt, policy, limits, model) so an edit conversation can start from truth. Refuses system-managed targets in words. |
| `agent_update` | `PUT /api/agents/:id` | the deliberately-missing tool, now homed where it belongs. Gated by the shared `canEditAgent` predicate (see "Edit authority" below) exactly like the route — refuses in words when the caller may not edit; `mergeGenericAgentToolPolicy` + `assertGenericAgentToolPolicyInput` stand, so protected/explicit-grant keys are untouchable; `systemManaged` targets refused. |
| `agent_tool_catalog` | `GET /api/tools` + `GET /api/mcp/tools` projection | read-only live catalogue: builtins (deny-mode), this org's active connector tools (allow-mode), and — named but not togglable — the explicit-grant tier with the words for where it is granted (Apps agent-access, DeepWater toggle, executor review). Same filtering as the page's `tool-catalog.ts`, served server-side so the two faces can't drift. |
| `agent_avatar_update` | `PATCH /api/agents/:id/avatar` + `POST …/avatar/generate` | owner-gated like the routes; create-time generation already happens inside `agent_create`. |

Deliberately **not** given: `connector_*` mutations (the conversational-
setup plan is retiring them; the Designer points at `/apps` and the
`app_connect_request` flow in words), any policy-target/grant mutation for
explicit-grant tools, agent delete (doesn't exist for anyone), DeepWater
bundle management, and `spawn_subtask`/`delegate` (a design conversation
needs neither; keeping them off keeps the catalogue-laden context from
fanning out).

### D5 — The capability catalogue is generated, never written

The Designer's authority is a structural system-prompt block **generated
from the same sources the product uses**, assembled at run setup:

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

Card mechanics it inherits for free: `input` blocks with `wait: true` park
the run in `waiting_input`; a person may ignore the card and answer in chat
— the reply reaches the agent as an ordinary turn and the card can be
cancelled/expired; `select` options cap at 20, so long lists (models) are
offered as a shortlist with "or name another".

### D7 — Not editable, by construction

Already true and kept: `createAgentRecord`/`updateAgentRecord` refuse
`systemManaged`; `PUT`/`DELETE`/avatar routes 404 through
`isAgentAccessibleToActor`; the clone route refuses system sources; the
Designer page's Global scope is read-only. Added: the read-only detail view
from the scopes doc (config visible, edit affordances absent) so "not
editable" is a visible fact rather than a 404; and the bootstrap re-applies
the blueprint on every deploy under the policy lock. The blueprint's
`toolPolicy` is asserted through `assertGenericAgentToolPolicyInput` at
bootstrap like the PA's, so the vendor config can't smuggle protected keys
either.

### D8 — `agent_handoff`: pass the person to the Designer

New builtin, available to **every** agent by default (`safe: false`, no
grant needed — its blast radius is a message into the requester's own
private DM plus a link card):

- **Args:** `{ target: <global-agent slug>, brief: string }`. v1 targets
  only registry slugs — handoff to arbitrary agents is a different feature
  (the chief-of-staff plan's bounded A2A conversation) and stays out.
- **Structural gates:** interactive run with a live requesting user
  (`payload.interactive === true` + acting member re-read); unattended and
  agent-authored runs get a plain refusal. No content heuristics anywhere —
  *whether* to hand off is the model's judgement, steered by a one-line
  structural routing block injected into every non-designer agent's prompt
  from the registry ("agent creation and redesign are handled by the Agent
  Designer; use `agent_handoff`"), the research-routing precedent.
- **Mechanics (the integration-handoff pattern, reused):** ensure the
  Designer bootstrap + the requester's DM; write one server-authored
  `role:'user'` message into that DM carrying the model's `brief` and
  `metadata.agentHandoff = { fromAgentId, originChannelId, originThreadId,
  originRunId }`; stamp the message's basis from the origin run's current
  `ConsumedSourceSink` remainder (the brief is model text built from that
  run's reads — the disclosure obligation travels with it, even though the
  destination is the requester's own private DM); enqueue the Designer run
  directly (orchestrator skipped), idempotent on
  `handoff:{originRunId}:{slug}`; post a small card in the origin thread —
  "Handed off to the Agent Designer" with an open-conversation link — so the
  person standing in the original channel has the doorway (Rule zero).
- **Loop safety:** the handoff message is server-authored into a
  single-member DM whose only agent is the target; nothing re-enters the
  orchestrator; `triggerIsHuman` guards are untouched.
- The Designer's replies land in its DM; when the person returns to the
  original channel, nothing has impersonated them there.

**PA `agent_create` retires from the PA once this ships** (recommended,
phase 4): the PA keeps `agent_list` / `agent_bind_channel` /
`agent_trigger_create` (operational verbs on existing agents) but routes
creation and redesign through handoff, which is the whole isolation story.
If quick one-shot creation from the PA proves to be missed, re-adding the
tool is one registry line — removing a learned behaviour later is harder.

### D9 — One brain, two doorways: unifying the sidebar

The Design Assistant sidebar keeps its transport (in-process SSE,
form-filling tool calls, ephemeral) — it does something the DM cannot: drive
the open form control-by-control. What unifies is the **definition**:

- One blueprint module exports the persona, the generated capability
  catalogue, and the parameter vocabulary; both
  `api/src/services/designer-prompt.ts` and the worker's Designer prompt
  build from it. The sidebar's five principles and the Designer's D6 persona
  become one text.
- The sidebar renders as the Agent Designer — name and avatar from the
  identity directory, not a generic "Design Assistant" label.
- The sidebar's model resolution stays (`NESSIE_DESIGNER_MODEL`), and the
  blueprint's model field feeds both faces.
- Its DuckDuckGo-scrape `web_search` is replaced by the Ledger Serper route
  the builtin uses (the direct-scrape path predates the Ledger-only rule and
  should not survive unification).
- A "Continue in chat" affordance on the sidebar opens the Designer DM
  (hand the form draft over as a server-authored context message).

A fully thread-backed sidebar (real runs rendered in the rail) is named as
the possible end-state but deliberately not built now: it trades the live
form-filling UX for architectural purity the product doesn't need yet.

## Edit authority — person-owned vs team-owned (decided 2026-09-02)

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
| Global | `systemManaged` | nobody; blueprint only |

"Edit" covers name, role, system prompt, model/provider, effort, run
limits, ordinary tool-policy keys, and avatar. It does **not** cover
bindings (placement keeps its own four gates), explicit-grant keys
(`assertGenericAgentToolPolicyInput` stands for every editor), or
`todosEnabled` (keeps its org-owner gate for now — it authorizes
trigger-driven work, a different blast radius).

Mechanics:

- **One predicate, `canEditAgent(actor, agent)`, in
  `@nessie/workspace-admin`**, replacing `requireOwner` at every agent-edit
  chokepoint (PUT, avatar update, avatar generate) and consumed verbatim by
  the Designer's `agent_update` / `agent_avatar_update` — the routes and
  the chat face cannot disagree by construction. Refusals are worded per
  state ("this agent is owned by <name>; ask them or an org owner").
- **Transitions are owner acts.** The existing PUT `ownerUserId` transfer
  grows the null case: the owner (or an org owner) may *release* an agent
  to the team (`ownerUserId → null`) or transfer it; `agent.owner_changed`
  already audits both. Claiming a team-owned agent (null → self) is
  deliberately **not** offered to arbitrary entitled members in v1 — an
  edit improves the agent for everyone, a claim locks everyone else out,
  and that social act stays with org owners until real use demands more.
- **"Promote" is the existing publish act** (private → workspace, the
  scopes doc's open question 4): ownership survives it, so a promoted
  agent is person-owned — you work with it together, only you edit it —
  exactly the asked-for behaviour. Team-owned is the explicit release
  afterwards.
- **Legacy unowned rows become team-owned.** Pre-stewardship agents have
  `ownerUserId = null` and no recorded author; "anyone entitled may edit"
  is the honest reading, and it is a strict widening only relative to a
  gate that was itself wrong. The people-tree's "Unowned" bucket renames
  to "Team-owned" in the same change.
- **Org-owner override stays on workspace agents** (both flavours):
  "only I can edit" is with respect to other members. Without the
  override, a person-owned agent whose owner is deactivated has no editor
  at all; the deactivation machinery pauses private agents but workspace
  agents keep running and must stay governable. Private agents remain the
  sanctioned exception.
- **Admin surface:** the agent detail header states the state ("Owned by
  <person>" / "Team-owned") with the release/transfer control for those
  entitled to use it; the scope tabs are untouched.
- **Doc obligation:** people-and-their-agents is amended in the same
  change — ownership now carries edit authority for workspace agents, and
  a null owner is a deliberate state ("team-owned"), not merely missing
  history.

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
| `avatarAttachmentId` / `avatarBackgroundColor` | may-edit | `agent_avatar_update`; auto-generated at create | |
| `ownerUserId` | create: forced to actor; update: owner/org-owner transfer **or release to team** (`null`) | `agent_update` (refused for private agents) | null = team-owned: anyone entitled may edit |
| bindings | org owner + policy + membership | `agent_bind_channel` | PA channels + private agents refused structurally |
| triggers | owner, UOA identity required for schedules | `agent_trigger_create` | |
| `parentAgentId`, `agentKind`, `systemManaged`, `surfacePolicy`, `delegationMode`, `executionMode`, `routingProfileId` | server/bootstrap only | **never** | the Designer states this when asked |

## The tool catalogue (what the Designer can offer an agent)

Grouped as the Designer presents them; flags: PA = personalAssistantOnly
(unavailable to shared agents — the Designer says so instead of toggling),
EG = requiresExplicitGrant (owner-surface granted, never by the Designer).

- **Web & research:** `web_search`, `web_fetch`, `http_fetch`, `delegate`,
  `spawn_subtask`, `document_read`
- **Conversation:** `message_search`, `workspace_search`, `people_search`,
  `channel_find`, `channel_list`, `react`, `message_edit`,
  `message_delete`, `card_post`, `attachment_upload/list/read`,
  `dashboard_widget_post`
- **Knowledge base:** `kb_search`, `kb_page_read`, `kb_list`,
  `kb_draft_write`, `kb_document_compose`, `kb_document_edit`, `kb_file`,
  `kb_publish_request`, `kb_comments_*`, `kb_note_add`
- **Dashboards:** `dashboard_*` (11 tools)
- **To-dos** (needs `todosEnabled`): `todo_template_propose`, `todo_start`,
  `todo_step_update`
- **Demonstrations:** `demonstration_start/stop`
- **PA-only** (never on a designed agent): `send_message`,
  `authored_message_search`, `update_preferences`, `channel_create/update/
  archive/join`, `agent_*` provisioning, `pa_join_channel`, `connector_*`,
  `executor_*`, `comms_connect_card`, `meeting_link_create`, `call_start`,
  `app_connect_request`
- **Explicit-grant** (owner surfaces): `browser_open/observe/act/close`,
  `gmail_*`, `calendar_*`, `deep_water_run_update`, projected
  `mcp_research_*`, every `executor.*` operation, and any connector tool
  whose instance carries `requiresExplicitToolGrant`
- **Org connectors:** the live active, non-protected MCP registry rows
  (allow-mode, keyed by registry uuid)

## Security invariants

1. **Route-mirroring, exactly.** Every Designer tool calls the shared
   `@nessie/workspace-admin` function its route calls, with the route's
   authorization re-derived from the live membership row at call time.
   Owner-gated verbs stay visible and refuse in words.
2. **No self-granting.** The Designer cannot write protected policy keys,
   cannot touch grants, cannot widen an app install, cannot create
   system-managed rows — all enforced at existing chokepoints, not by
   prompt.
3. **Identity is structural.** `effectiveUserId` comes from the
   single-member DM stamp, never from content; the identity-delegated tool
   arm (D3) requires that surface.
4. **Handoff carries provenance.** The handoff message's basis is stamped
   from the origin run's sink remainder; unattended runs cannot hand off.
5. **The blueprint is config, not authority.** Bootstrap policy passes the
   same `assertGenericAgentToolPolicyInput` as user input.
6. **No new hierarchy, no UOA duplication.** Per-org rows; nothing cross-org;
   `systemSlug` is a Nessie fact about a Nessie object.

## Phases

0. **Edit authority (independent, ships first).** `canEditAgent` in
   `@nessie/workspace-admin`; PUT + avatar routes migrate off
   `requireOwner`; release-to-team on the transfer path; admin ownership
   state + control; "Unowned" bucket renamed; people-and-their-agents
   amended. DB-backed tests: private-owner edit allowed, foreign-private
   denied even for org owners, person-owned denies other members, team-owned
   allows any entitled member, org-owner override on workspace agents,
   protected-key refusal unchanged for every editor.
1. **Foundation.** `Agent.systemSlug` + CHECK extension (fourth tuple) +
   `gagent:` DM CHECK, blueprint registry + `ensureGlobalAgent`, the
   Designer blueprint, per-user DM provisioning + `system_agent` channel
   type, orchestrator fast-path + `effectiveUserId` stamp, run-start surface
   assertion, sidebar-DM + Global-tab + identity-directory visibility.
2. **The Designer at work.** D3 gate arm; new tools `agent_read`,
   `agent_update`, `agent_tool_catalog`, `agent_avatar_update` (shared
   functions + re-exports); generated capability-catalogue prompt block;
   persona; card-driven collection. Verify end-to-end: describe → question →
   card → create → home DM link.
3. **Handoff.** `agent_handoff` builtin + server-authored delivery + origin
   link card + routing prompt block for all non-designer agents.
4. **Consolidation.** Retire PA `agent_create`; unify the sidebar onto the
   blueprint module (persona, catalogue, identity, Ledger search); read-only
   global-agent detail view.

Each phase lands with its admin surface (Rule zero), docs updates
(CLAUDE.md "Personal assistant — workspace provisioning" gains the Designer
section; the scopes doc's status banner updates), Playwright verification of
every UI change, and DB-backed tests for: bootstrap idempotency + policy
merge, the CHECK tuples, DM single-membership, the D3 gate (allowed in DM,
denied elsewhere, denied for ordinary shared agents), handoff idempotency +
basis stamping + unattended refusal, and `agent_update` mirroring
(non-owner refusal, protected-key refusal, system-target refusal).
Engagement/handoff fixtures include non-English, slang, and misspelled
inputs per the intent-is-model-judged rule.

## Open questions

1. **Does the Designer get a per-org model pin?** Blueprint says org-default
   model (the Librarian's cost stance) vs pinning `NESSIE_DESIGNER_MODEL`
   for both faces. Recommended: org default, env override honoured.
2. **Team-scoped DM keys?** `gagent:` omits the UOA team (unlike
   `extagent:`). Creation acts org-wide, so one DM per user per org seems
   right; confirm against the team-switch UX before the CHECK lands.
3. **How eagerly does bootstrap run?** Login-time (PA-style) vs lazy on
   first doorway use. Recommended: login-time — the sidebar DM row is a
   discovery surface and should simply be there.
4. **May entitled members claim a team-owned agent?** v1 says no (org
   owners only) — an edit helps everyone, a claim locks everyone else out.
   Revisit if release/claim churn shows up in real use.

(The former open question — whether `PUT /api/agents/:id` should grow an
owner-of-private-agent arm — is resolved by the "Edit authority" section:
the fix is the `canEditAgent` model, decided 2026-09-02.)

## Adjacent defects noticed while mapping (filed separately)

- ~~`createExternalAgentData` writes a tuple `agents_system_managed_invariants_chk`
  forbids; only a fake-Prisma test covers it.~~ **Fixed** in migration
  `20260902170000_external_agent_surface_invariants`, which also had to extend
  `channels_personal_assistant_surface_chk`: `external_agent` had been added to
  `ChannelSystemType` without the surface CHECK learning the `extagent:` DM key,
  so the bootstrap failed twice over. `api/test/external-agent-bootstrap-db.test.ts`
  now drives the real service against Postgres — the cast fake could not see
  either CHECK. This is the `extagent:` lesson D2 cites, and D1's fourth tuple
  ships with it.
- ~~`POST /api/designer/chat` never passes `pageContext` into
  `buildDesignerSystemPrompt` (4th arg dropped), so the page-scoped control
  rule is client-side only.~~ Fixed: `streamDesignerChat` now forwards
  `input.pageContext` (`api/src/services/designer.ts`).
- `PA_PRESENCE_PRIVATE_READ_TOOL_IDS` lists `message_post`, which matches no
  tool (stale rename of `send_message`; harmless today, dead entry).
- `CreateAgentBodySchema` accepts `routingProfileId` but the route drops it
  before `createAgentRecord`.

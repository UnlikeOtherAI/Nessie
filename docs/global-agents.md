# Global agents — the Agent Designer's mechanics

The invariants live in `AGENTS.md` → "A global agent is a blueprint in code",
and the map entry in `CLAUDE.md` → "Global agents". This file holds the
mechanics beyond both: what the Agent Designer's tools stand on, how its
capability catalogue is generated, how `agent_handoff` delivers a briefing, and
how the Agent Designer page's sidebar became the same agent rather than a second
one.

Spec and full history:
[plans/2026-09-02-agent-designer-global-agent.md](plans/2026-09-02-agent-designer-global-agent.md).

## The model a global agent runs on

Blueprint pin → `NESSIE_DESIGNER_MODEL` → the organisation's default, resolved
once by `resolveGlobalAgentModel` and used by **both** Designer faces, so the
chat agent and the page sidebar can never answer on different models. A
blueprint that pins nothing (the Librarian's cost stance) simply inherits the
organisation's choice.

## The Designer's toolset

The toolset is the blueprint's `identityToolIds`: the five Personal Assistant
provisioning verbs plus `agent_read`, `agent_update`, `agent_tool_catalog` and
`agent_avatar_update` — `personalAssistantOnly` builtins whose handlers live in
`worker/src/run/pa-tools/agent-config.ts` over shared
`@nessie/workspace-admin` functions.

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
  `@nessie/workspace-admin` because the worker cannot import
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

`buildGlobalAgentCatalogueBlock` (`@nessie/workspace-admin`) renders parameters
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

`deliverGlobalAgentBrief` (`@nessie/workspace-admin`) is the only way a briefing
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
  workspace has, and while it was, the two faces could enumerate different
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

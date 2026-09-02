# Global agents — the Agent Designer's mechanics

The invariants live in `AGENTS.md` → "A global agent is a blueprint in code",
and the map entry in `CLAUDE.md` → "Global agents". This file holds the
mechanics beyond both: what the Agent Designer's tools stand on, how its
capability catalogue is generated, how `agent_handoff` delivers a briefing, and
how the Agent Designer page's sidebar became the same agent rather than a second
one.

Spec and full history:
[plans/2026-09-02-agent-designer-global-agent.md](plans/2026-09-02-agent-designer-global-agent.md).

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

## The read-only configuration view

`readAgentConfigView` composes `readAgentRecordForActor` with
`loadAgentToolCatalog`, resolving the sparse policy map into the tools the agent
actually has: `default` (a deny-mode builtin nothing removed), `policy`
(switched on for this agent), or `reserved` (a blueprint identity tool no policy
can grant, exercisable only in the agent's own conversation).

`GET /api/agents/:agentId/config` serves it under exactly the list entitlement,
and `admin/src/components/features/agents/SystemAgentConfigPanel.tsx` renders it
in place of the detail tabs for any `systemManaged` agent, with no edit
affordance at all. `isAgentAccessibleToActor` is deliberately untouched: status,
activity, messages and children still 404 on a system agent, because a global
agent's activity spans every member's private DM.

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
  (`@nessie/workspace-admin`) is true for the Personal Assistant and for any
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

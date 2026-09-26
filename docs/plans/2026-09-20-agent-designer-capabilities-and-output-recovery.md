# Agent Designer capabilities and output recovery

## Request and verified incident

Agent Designer must configure every editable aspect of another agent, including
its tools and resource access, acting with the requesting person's authority.
The person should not have to move to Settings to finish a grant the conversation
can perform. Preserve UOA authority, tenancy, private resource ownership, and
native or OAuth consent that actually needs human interaction.

Production inspection on 2026-09-20 matched the supplied screenshot in the
UnlikeOtherAI organisation. Run `befff57c-b234-419b-a50b-b4624121adc3`
started at 13:47 UTC and stopped after eight iterations and eight tool calls.
Its recorded effective usage was 107,323 tokens (283,299 raw, 234,632 cached).
The model was `openrouter/meta/muse-spark-1.3-contributor`. Two chat invocations
used exactly 2,048 output tokens with `responseEmpty: true`. No CTO agent existed
when inspected. The run checkpoint reason was `token_limit`.

Confirmed defects and contributing paths:

1. `global-agent-blueprints.ts` explicitly tells Designer to send protected
   grants to owner Tools controls. `agent-tool-catalog.ts` marks these restricted,
   and generic agent updates intentionally reject protected policy keys. The
   missing capability is an authorized specialist grant operation, not removal
   of generic policy protection.
2. `tool_spec` was denied with `private_conversation_disclosure_required` during
   this run. The subsequent `card_post` used malformed arguments and failed
   with `Required`. Inspect the metadata/disclosure classification: schema
   discovery reads authorized tool schemas; it is not an external write.
3. The configured default output cap is 2,048. `resolveAdvertisedOutputTokens`
   takes the minimum of this cap and advertised model limits. The existing
   recovery repeats a no-tools call under the same output allowance.
4. `agentic-loop.ts` maps repeated output finalization `length` to `stop('tokens')`
   even when the run allowance is not exhausted. This produces the false
   107,323-token limit message in the screenshot.
5. `continuation.ts` excludes every interactive run from automatic checkpoint
   continuation, and its enqueue path stamps `interactive: false`. Merely
   removing the exclusion would strip Designer's delegated tools.

## Implementation plan

1. Audit all agent edit and access surfaces against Designer's tool contracts:
   configuration/core/style/avatar/model/provider/subscription, limits, ownership,
   todos, placement/triggers, generic tools, protected builtin/MCP grants,
   DeepWater bundle, cloud/private browser, executor and connected resources.
   Implement missing conversational paths using shared route service functions.
   Move API-owned reusable policy/grant logic into the appropriate shared package
   before reusing it; API routes and worker tools must keep one implementation.
   Report actual consent or deployment-only boundaries explicitly.
2. Provide discoverable, identity-delegated capability inspection and mutations
   with exact agent/resource targets. Enforce fresh requesting-member and resource
   authority, cross-org/private denials, bundle readiness and revocation locks,
   audit and realtime parity. Keep generic protected-key writes closed. Support
   grant and revoke; present real missing connections through existing in-chat
   connection or consent flows. Update blueprint/catalogue instructions so they
   accurately describe the new capability instead of refusing it.
3. Repair `tool_spec` classification without weakening the disclosure guard for
   content writes. Preserve allowed-tool filtering and test restricted/private
   conversation schema discovery and subsequent valid card creation.
4. Remove application-imposed output-token ceilings from agent responses,
   including defaults and provider-adapter fallbacks that silently restore them.
   Guide clear, concise, proportionate communication through system prompts;
   never use a deterministic token cap as a verbosity control. Context admission
   and real run/organisation spend budgets remain separate safeguards, without
   silently translating them back into a response token ceiling. Retain bounded
   recovery for provider-imposed truncation. Never execute incomplete tool calls
   or replay completed mutations. Identify utility-only operational limits
   separately from the main conversational path.
5. Separate provider output exhaustion from run token exhaustion through result,
   checkpoint, event, continuation and UI metadata. Recover automatically where
   safe instead of returning the screenshot's manual Continue dead end. If a
   checkpoint rollover is needed, preserve the original human, delegated identity,
   reply placement, disclosure and UOA provenance, revalidate live access, retain
   cancellation and finite continuation bounds. Never bypass real budget holds or
   loop guards. A provider that repeatedly cannot finish must produce a truthful
   actionable failure, not a fabricated run token limit.
6. Add durable regression coverage: owner Designer grants/revokes target access;
   non-owner, private, cross-org and unattended requests denied; DeepWater bundle
   and revocation invariants; every new tool exposed only on the intended surface;
   private `tool_spec` and card flow; main provider requests omit output-token
   caps and include communication guidance; reasoning-only length then success; repeated
   length accurately classified; real budget exhaustion; checkpoint recovery with
   identity, cancellation, replay and bounded continuation. Run focused tests via
   Turbo with a dedicated migrated database and required builds/lint/typechecks.
   Add a scripted model browser flow showing the complete Designer interaction.
7. Update affected standards, including AGENTS/CLAUDE signposts for tool changes.
   Integrate Terra's pushed commits into one PR, pass required CI and appropriate
   browser suites, merge, verify exact-SHA production promotion and runtime health.
   Preserve evidence outside disposable worktrees before cleanup.

## Review sequence

Kimix independently verifies these findings and plan before Terra implements.
Terra owns implementation, regression tests, and self-review in its own worktree;
the orchestrator reviews and integrates the completed work and ships one PR.

## Provider protocol verification

Live Kimi Coding API probes on 2026-09-20 used a synthetic connectivity prompt,
without organisation or conversation content. The `/coding/v1/models` response
advertised `context_length: 1048576` for `kimi-for-coding`, but no output maximum.
Identical Messages requests produced these results:

| Request output field | HTTP result | Provider stop | Actual output tokens |
| --- | --- | --- | --- |
| Omitted `max_tokens` | 400 | Invalid request | None |
| `max_tokens: 32` | 200 | `max_tokens` | 32 |
| Advertised context capacity, `max_tokens: 1048576` | 200 | `end_turn` | 48 |

Consequently, protocols that require this field must receive provider-advertised
capacity, rather than a Nessie verbosity allowance. Other main conversational
requests omit it. Do not invent a static Kimi output limit or disable working
Kimi conversations because the provider reports context capacity rather than a
separate output maximum. The ordinary system prompt governs communication.

## Amendment 2026-09-23 — what the Designer hands the person

Found while building a CTO agent through the Designer
([usability report](../testing/cto-agent-usability-2026-09-22.md), findings 6
and 9). The rule in both: a tool result is data the Designer relays, so
nothing in it may be a secret or an instruction addressed to the model.

- **Tool output carries links, not ids (F9).** `agent_create` printed
  `agentId=<uuid>` and `Its private home is channelId=<uuid>`, plus "Tell them
  so, and give them this reason word for word" when no portrait was drawn; the
  Designer's completion message repeated all of it. It now answers
  `Created agent [CTO](/agents/<id>) (…)`, `Lives in: nowhere yet — add it to
  any channel` or its private home as `[#name](/channels/<id>)`, and
  `portrait: none (reason: "…")`; `agent_bind_channel` answers with the same
  two links, and `channel_create` adds the new room's link beside its ids. A
  later call reads the id from the link's last segment, and the Designer's
  persona and `agent_create`'s description both say so. "Quote the portrait
  reason word for word", "report a pinned portrait style" and "link what you
  made, never a raw id" moved into the Designer's persona
  (`global-agent-blueprints.ts`); `agent_avatar_generate`'s "Say so." became
  the data line `style: pinned at the <scope> level; …`. `project_create`,
  `agent_list` and `agent_trigger_create` followed: `[Name](/projects/<id>)`,
  one `[Name](/agents/<id>)` row per agent with its rooms as channel links,
  and the trigger as `[Name](/agents/triggers/<id>)` beside the agent it
  fires and the room it posts into. The persona names the link each
  `projectId`, `agentId` and `triggerId` is read from, and says a
  `/agents/triggers/…` link is never an agent's. `channel_create` then dropped
  its `channelId=` line, and `project_list`, `team_create`,
  `agent_trigger_list` and `agent_trigger_update` link their projects and
  triggers too; a team, which has no page, keeps `"Name" (teamId=<id>)`.
- **An executor grant is confirmed from a card, not a link (F6).**
  `executor_agent_grant_prepare` answered with
  `/agents/executors?accessChange=<id>#confirmationToken=<token>`. The secret
  scanner redacts every tool result before the model reads it, rightly, so the
  link the Designer posted carried `PkbZ••••` and the review it opened said the
  token was missing. The prepare tools now post a system-authored confirmation
  card in the requester's own DM that stores only the access-change id and
  answers only that person; every press of Review mints a fresh token
  server-side for that same person and opens the existing review dialog with
  it. The card is pressed, not answered: it stays open while the change is
  pending, so a review closed early or lost to a reload is opened again, and
  it closes when the change is confirmed, rejected or expires. The workspace
  promotion prepare tool had the same token in its output and posts the same
  card. The model is told only that a confirmation card was posted. The
  access-change rules are unchanged — same actor, the token, fresh verification
  for an allow — and nothing in section 1's grant model moves: a person still
  confirms every executor grant. Mechanics:
  [agent cards](../standards/agent-cards.md) → "An executor review card holds
  an id".

- **A restricted label is about the designed agent, and the block now says
  whose verb it is (2026-09-23).** Asked "can CTO see executors?", the
  Designer answered that `executor_list` / `executor_agent_grant_prepare`
  "are Personal Assistant only — I can't grant it from here" — while holding
  all three executor verbs through identity delegation, in the very
  conversation whose executor section told it to use them. The catalogue's
  restricted list ("Tools that exist but are not yours to grant") rendered
  every `personal_assistant_only` builtin with that label, and for the home-DM
  face three of those keys were its own. Same failure and same remedy as
  `protectedAccess`: whether a verb is "not yours" is a property of the face
  reading the block, so `buildGlobalAgentCatalogueBlock` now takes the run's
  resolved tool ids (`heldToolIds`) and renders a held restricted verb under
  "Verbs you hold in this conversation" — never under the not-yours list, and
  never as "Personal Assistant only". The admission machinery needed no
  change: the verbs were resolved and in the schema array all along; the
  prompt was the only thing refusing.

- **The Designer's delegated set is the whole act-as-user surface
  (2026-09-23, owner decision).** `identityToolIds` was a curated list that
  had quietly fallen behind what the person's own delegate could do — 51
  verbs behind, which is how "can CTO see executors?" got a refusal while
  the grant machinery sat ready. It is now derived: every
  `personalAssistantOnly` builtin, minus explicit-grant verbs (an owner's
  per-agent allow is never implied by delegation) and the verbs whose handlers
  refuse any face but the PA's own DM (`pa_join_channel`,
  `app_connect_request` — each named with its reason beside the
  derivation). The surface conditions are unchanged — own home DM,
  interactive turn, live human requester — and every handler keeps
  mirroring its route's authorization, so the person asking can still only
  reach what they could reach themselves. `connector_uninstall`'s earlier
  deliberate absence ("designing an agent is never a reason to take an app
  away") is superseded by the owner's rule; the handler's own scope checks
  remain the boundary.

## Amendment 2026-09-26 — a linked plan, a grant before its key, a new team

Three findings from one conversation ("hey I want an agent called Pirate"),
each a fact the Designer was not given rather than a rule it broke.

- **A person's own plan was invisible to the chat face.** Kimi linked under
  Settings → Connected accounts is a `ModelSubscription`, not a connector; the
  model picker lists it (`GET /api/agents/models` composes Ledger plus the
  person's plans), but the worker's catalogue loader read `listLedgerAgentModels`
  alone, so the Designer searched the connector library, found nothing, and
  said so. The loader now reads `listAgentModelOptionsForUser` — the picker's
  own function, disabled pairs filtered, plans included — for the home-DM face
  only; the catalogue's model section (`global-agent-model-catalogue.ts`) lists
  the plans in full in their own group, never behind the twenty-entry
  deployment shortlist that also hid them on the page sidebar; `agent_create`
  gained `modelSubscriptionId`; and the persona says what a linked plan is and
  where one is linked. `packages/team-admin/test/global-agent-catalogue.test.ts`,
  `worker/test/db/designer-model-catalogue.test.ts`.
- **"Just set up the permissions, I'll add the tokens later" was refused by
  prose alone.** Granting a browser tool never reads a Browserbase connection
  (`setAgentToolPolicyForRegistryEntry`); only using one does. Three texts said
  otherwise: the main prompt's Browserbase block, rendered for every agent
  without the `canGrantBrowserTools` fact the catalogue's copy already had
  ("an owner must explicitly grant … at Agents → Tools", which the Designer
  quoted); its `browser_login_request` line, which told a deployment-managed
  agent to have an owner enable a tool on its own fixed toolset; and the
  persona's "an agent gets its tools when you create it, never afterwards",
  while every explicit grant is written after creation. The block now takes
  `canGrantBrowserTools` and `ownToolsetFixed` from the resolved toolset and
  the agent row, says a grant does not wait for the account, and the persona,
  the tool descriptions and the validator's message all say create, then
  grant with `agent_tool_access_set`, before any key exists. Executors stay the
  honest exception: a grant names one paired machine its owner confirms.
  `packages/runtime/test/browserbase-setup-prompt.test.ts`,
  `worker/src/run/execute/prompt.test.ts`,
  `packages/team-admin/test/agent-designer-blueprint.test.ts`.
- **A brand-new team had no Personal Assistant and no Agent Designer.** Both
  are one row per organisation, so every team of an organisation shares them;
  what was missing was the person's first entry into a *new* organisation —
  the in-app "New organisation" the create-team dialog defaults to for anyone
  not an org admin — which lands through `materializeUoaTeam` with no login
  behind it, and nothing there ran the bootstrap the four login sites ran.
  One function (`api/src/services/system-agents-bootstrap.ts`) now serves the
  four sites and runs, best-effort, on every team materialization and on the
  local context switch. `api/test/uoa-team-switch-system-agents-db.test.ts`.

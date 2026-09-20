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

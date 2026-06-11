# Usage & Billing Tracking — Plan

**Goal:** Every billable interaction (AI first, then third-party connectors) is
recorded once, at a single instrumented chokepoint, with full attribution —
**who** (actor/user/agent), **where from** (org / project / team / channel /
agent / run / task / thread), **how much** (calls, tokens/units, cost). This is
the data foundation for per-tenant billing.

Derived from the architecture review (5 cross-verified analyses, 2026-06-11).
Agent reports: `/tmp/nessie-ai-audit/{codex-ai,codex-external,glm-ledger,glm-context}.md`.

## Current state (verified)

- **AI agentic loop** already records billing-grade `TokenLedgerEvent` rows
  (per invocation, full attribution, provider + estimated cost, idempotent):
  `worker/src/run/execute.ts:1520` → `persistInvocationLedgerEvents`
  (`worker/src/run/inference.ts:774`). Excellent — keep it, generalize it.
- **Unledgered AI paths** bypass the ledger (only an in-memory tracker):
  `createModelClient` (`packages/runtime/src/model.ts`) used by the orchestration
  engagement decision (`packages/runtime/src/orchestrator.ts:127`), memory
  capture/search/consolidation (`packages/memory/*`), thoughts, and the agent
  designer (`api/src/services/designer.ts:278`). These cost real money and are
  invisible to billing **and** budgets.
- **Third-party connectors** (MCP runtime, HTTP tools, web search, push,
  storage) have no usage ledger at all. `ToolCall`
  (`worker/src/run/execute.ts:912`) records only name/duration/success.

## Design

One flat attribution shape + one writer per ledger, both in `@nessie/runtime`
(which already owns `budget.ts` and reads the ledger):

- `LedgerAttribution` — `{ organizationId, projectId?, teamId?, channelId?,
  threadId?, sessionId?, taskId?, runId?, agentId?, actorId, actorType?,
  requestId?, correlationId? }`.
- `recordInferenceUsage(prisma, { attribution, invocations })` — the existing
  `persistInvocationLedgerEvents` logic (pricing lookup, FK resolve, cost calc,
  idempotent `tokenLedgerEvent.create`), sourced from `attribution`.
- `recordConnectorUsage(prisma, { attribution, event })` — sibling writer for
  `ConnectorUsageEvent`.

`createModelClient` gains a `recordUsage` sink; `ModelOptions`/`EmbedOptions`
gain an optional `usage?: LedgerAttribution`. api/worker construct the client
with `recordUsage: (invs, attr) => recordInferenceUsage(prisma, …)`. Unwired
call sites simply pass no `usage` and behave as today (safe incremental rollout).

## Schema (one additive migration — no reset)

- `TokenLedgerEvent`: add `runId` (uuid, nullable) + `actorType`
  (`AuditActorType`, nullable) + index `[organizationId, runId, occurredAt]`.
- New `ConnectorUsageEvent` + `ConnectorType` enum (mcp / http / web_search /
  web_fetch / storage / push / github / oauth / other): attribution columns +
  `connectorType`, `connectorId?`, `target?`, `operation?`, `calls`, `units?`,
  `unitType?`, `costAmount?`, `costCurrency?`, `success?`, `latencyMs?`,
  `metadata?`; per-dimension indexes.

## Phases

### Phase 0 — Foundation (sequential)
1. Schema + hand-written additive migration + `prisma generate`.
2. `packages/runtime/src/ledger.ts`: `LedgerAttribution`, `recordInferenceUsage`,
   `recordConnectorUsage`, `attributionFromActorContext` helper. Export from index.
3. `createModelClient`: `recordUsage` sink + `usage` option threading.
4. Refactor worker `persistInvocationLedgerEvents` to delegate to
   `recordInferenceUsage` (adds `runId`/`actorType` to the agentic path).
5. Wire api/worker `createModelClient` construction with the sink.

### Phase 1 — Complete AI billing coverage (the priority; parallel leaf wiring)
- **Orchestrator**: thread attribution from `executeOrchestrateDecideJob`
  (`actorContext`) into `decideAgentEngagement` → `modelClient.chat`.
- **Memory**: build attribution from `CaptureThoughtInput` /
  `SearchThoughtsInput` and pass `usage` to `getEmbedding` / `extractMetadata` /
  `extractReasoning` (capture, search, consolidation).
- **Designer**: thread `actorContext` into `streamDesignerChat`; record usage
  from the parsed SSE usage chunk.
- **Thoughts**: covered transitively by memory (capture/search) — verify routes
  pass actor context.
- Quarantine/ignore `simulation/lib/brain.ts` (dev harness, raw fetch) — out of
  the billable path.

### Phase 2 — Connector usage ledger (parallel track)
- `recordConnectorUsage` at the runtime dispatch sites: MCP
  (`worker/src/run/tool-mcp.ts` via `mcp-toolset.ts`), HTTP tool
  (`tool-http.ts`), `web_search`, `web_fetch`. Thread attribution from the run
  context (currently dropped at `mcp-toolset.ts:146`).
- Stretch: push (`worker/src/control/push-dispatch.ts`) and storage.

### Phase 3 — Reporting, budgets, docs (follow-up)
- Extend `getTokenUsageSummary` group-by to `runId`; add a connector-usage
  summary endpoint; surface in admin.
- Optionally add agent- and channel-scoped budgets (ledger is already indexed).
- Update `docs/functionality.md` and this doc; move to `docs/done/` when shipped.

## Verification
- `pnpm -r build`, `pnpm -r lint`, `pnpm -r test` must pass.
- Manual: trigger an orchestrator decision + a memory capture + a designer chat,
  confirm new `token_ledger_events` rows with the new attribution; trigger an MCP
  tool call, confirm a `connector_usage_events` row.

# Token Ledger and Cost Estimation Model

> Status: target-state design.

## 1) Objective

Track model usage for every organization across every provider, model, tool path, and agent run.

The ledger must:
- record all input and output token counts,
- support any AI provider and any model name,
- store provider-reported cached-token or cache-hit metrics when available,
- support custom admin-entered pricing overrides,
- produce monthly cost estimates at organization, team, project, channel, agent, user, and model levels.

This is an accounting and governance feature, not just a dashboard.

## 2) Core rules

- every model call that exposes usage metadata must emit a token-ledger event.
- token ledger is organization-scoped first, then sliceable by project/team/channel/agent/user.
- provider/model identity must be stored as raw values, not a fixed enum.
- if a provider exposes cached-token counts, prompt-cache hits, or similar reuse metrics, they must be captured as separate ledger fields.
- if a provider does not expose a metric, the field remains null rather than guessed.
- organization owners and admins may define override pricing for estimation.
- team owners may view team-scoped usage and cost rollups, but they do not define pricing profiles by default.
- canonical ledger preserves both:
  - provider-reported cost/usage fields when available,
  - Nessie-estimated cost using the active pricing profile.

## 3) Usage event model

```ts
type TokenLedgerEvent = {
  eventId: string;
  occurredAt: string; // ISO timestamp
  organizationId: string;
  projectId?: string;
  teamId?: string;
  channelId?: string;
  threadId?: string;
  sessionId?: string;
  taskId?: string;
  agentId?: string;
  actorId?: string;
  requestId?: string;
  correlationId?: string;
  provider: string;   // e.g. "openai", "anthropic", "minimax", "google", "custom"
  model: string;      // provider-native model name
  operationType:
    | 'chat'
    | 'completion'
    | 'embedding'
    | 'translation'
    | 'reasoning'
    | 'tool-translation'
    | 'other';
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    cachedOutputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    totalTokens?: number;
  };
  providerReportedCost?: {
    amount: number;
    currency: string;
  };
  pricingSnapshot?: {
    profileId: string;
    source: 'provider-default' | 'org-override' | 'team-override' | 'manual';
    currency: string;
    inputPerMillion?: number;
    outputPerMillion?: number;
    cachedInputPerMillion?: number;
    cachedOutputPerMillion?: number;
    cacheReadPerMillion?: number;
    cacheWritePerMillion?: number;
  };
  estimatedCost?: {
    amount: number;
    currency: string;
  };
  metadata?: Record<string, unknown>;
};
```

Rules:

- top-level scope fields are denormalized index fields for reporting
- `actorId`, `requestId`, and `correlationId` must be copied from the canonical shared access context when available
- `tool-translation` means translation work performed as part of a tool or tool-wrapper path rather than a direct user translation request

## 4) Pricing model

```ts
type ModelPricingProfile = {
  profileId: string;
  organizationId: string;
  provider: string;
  modelPattern: string; // exact model or wildcard pattern
  currency: string;
  source: 'provider-default' | 'org-override' | 'team-override' | 'manual';
  inputPerMillion?: number;
  outputPerMillion?: number;
  cachedInputPerMillion?: number;
  cachedOutputPerMillion?: number;
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
  effectiveFrom: string;
  effectiveTo?: string;
  createdBy: string;
};
```

Rules:
- pricing lookup should choose the most specific active profile:
  1. exact organization+team+provider+model override,
  2. organization+provider+model override,
  3. organization wildcard override,
  4. provider default pricing profile.
- overrides affect estimates only unless explicit provider-reported cost is unavailable.
- reports should show both:
  - provider-reported cost when available,
  - Nessie-estimated cost under the active pricing profile.

## 5) Monthly estimation and reporting

Required rollups:
- by organization,
- by team,
- by project,
- by channel,
- by user,
- by agent,
- by provider,
- by model,
- by operation type.

Required metrics:
- input tokens,
- output tokens,
- cached input tokens,
- cached output tokens,
- cache read/write tokens where available,
- total estimated cost,
- total provider-reported cost,
- delta between reported and estimated cost,
- billing period totals and month-to-date totals.

## 6) API and control-plane contracts

- `POST /ledger/tokens/events`
  - ingest one or more token usage events
- `GET /ledger/tokens/summary`
  - filters: `organizationId`, `projectId`, `teamId`, `channelId`, `agentId`, `actorId`, `provider`, `model`, `from`, `to`, `groupBy`
- `GET /ledger/tokens/events`
  - raw event stream with deterministic pagination
- `GET /ledger/tokens/pricing`
  - list active pricing profiles
- `POST /ledger/tokens/pricing`
  - create or update a pricing override
- `DELETE /ledger/tokens/pricing/{profileId}`
- `GET /ledger/tokens/monthly-estimate`
  - monthly estimate and forecast by scope

Suggested MCP/control actions:
- `ledger.tokens.event.ingest`
- `ledger.tokens.summary.get`
- `ledger.tokens.events.list`
- `ledger.tokens.pricing.list`
- `ledger.tokens.pricing.upsert`
- `ledger.tokens.pricing.delete`
- `ledger.tokens.monthly_estimate.get`

## 7) Governance and permissions

- organization owners/admins can read org-wide token and cost reports.
- team owners can read team-scoped usage and cost reports.
- pricing overrides should require organization owner or admin permissions.
- reports must respect project/team/channel visibility boundaries.
- pricing overrides must be auditable:
  - who changed it,
  - previous price,
  - new price,
  - effective time.

## 8) Runtime requirements

- ledger ingestion should be best-effort but durable:
  - usage events should not be silently dropped when downstream reporting is unavailable.
- missing usage metadata must be explicit in the event record.
- translation calls and other helper-model calls should also be tracked in the same ledger.
- looped or parallel agent runs should emit separate usage events and still roll up cleanly under one task/thread.

## 9) Cross-links

- [functionality.md](./functionality.md)
- [organization-governance-spec.md](./organization-governance-spec.md)
- [language-and-translation-spec.md](./language-and-translation-spec.md)

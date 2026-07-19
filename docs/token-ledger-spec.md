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
  actorId: string;
  requestId: string;
  correlationId?: string;
  provider: string;   // e.g. "openai", "anthropic", "minimax", "google", "custom"
  model: string;      // provider-native model name
  providerId?: string; // FK → inference_providers.id (nullable); resolved at write time, SetNull on delete
  modelId?: string;    // FK → inference_models.id (nullable); resolved at write time, SetNull on delete
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
- `provider`/`model` strings are the durable record (kept verbatim so a deleted or
  renamed catalog entry never corrupts an immutable ledger row). `providerId`/`modelId`
  are nullable FK columns resolved from those strings at write time, added for fast
  joins to the inference catalog; `onDelete: SetNull` drops the id but keeps the string.
  Rows whose provider/model are not in the catalog (e.g. the legacy env-key path) keep
  null ids.
- `actorId` and `requestId` are required — they must be copied from the canonical `AuthorizedActionContext`; `correlationId` is optional and copied when available
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

All endpoint paths include the `/api/` prefix per [hosted-app-architecture.md](./hosted-app-architecture.md) section 13.

- `POST /api/ledger/tokens/events`
  - ingest one or more token usage events
- `GET /api/ledger/tokens/summary`
  - filters: `organizationId`, `projectId`, `teamId`, `channelId`, `agentId`, `actorId`, `provider`, `model`, `from`, `to`, `groupBy`
- `GET /api/ledger/tokens/events`
  - raw event stream with deterministic pagination
- `GET /api/ledger/tokens/pricing`
  - list active pricing profiles
- `POST /api/ledger/tokens/pricing`
  - create or update a pricing override
- `DELETE /api/ledger/tokens/pricing/{profileId}`
- `GET /api/ledger/tokens/pricing/{profileId}/audit`
  - immutable history of changes to a pricing profile (who changed, previous/new values, effective dates)
- `GET /api/ledger/tokens/monthly-estimate`
  - monthly estimate and forecast by scope

Suggested MCP/control actions:
- `ledger.tokens.event.ingest`
- `ledger.tokens.summary.get`
- `ledger.tokens.events.list`
- `ledger.tokens.pricing.list`
- `ledger.tokens.pricing.upsert`
- `ledger.tokens.pricing.delete`
- `ledger.tokens.pricing.audit`
- `ledger.tokens.monthly_estimate.get`

## 7) Governance and permissions

- organization owners/admins can read org-wide token and cost reports.
- team owners can read team-scoped usage and cost reports.
- pricing overrides should require organization owner or admin permissions.

> **Current enforcement:** all reporting reads — `GET /api/ledger/tokens/summary`,
> `GET /api/ledger/tokens/monthly-estimate`, and `GET /api/ledger/tokens/pricing` —
> require organization-owner permission (`requireOwner`), matching the pricing
> mutation routes. Finer-grained team-owner-scoped read access is not yet
> implemented; until it is, non-owner members cannot read ledger reports.
> Month boundaries for monthly estimates are computed in UTC, consistent with the
> budget gate. The per-project/team/channel reporting scopes are backed by
> `(organization_id, <scope>, occurred_at DESC)` indexes on `token_ledger_events`.
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

## 9) Audit integration

Every pricing override change must emit an audit event to the audit trail (see [audit-trail-spec.md](./audit-trail-spec.md)). Audited actions:

- `pricing.created` — new pricing profile created
- `pricing.updated` — pricing profile values changed (record previous and new values)
- `pricing.deleted` — pricing profile removed

The `GET /api/ledger/tokens/pricing/{profileId}/audit` endpoint queries the audit trail filtered by `resourceType=pricing` and `resourceId={profileId}`.

## 10) Customer billing aggregate

The local Nessie token/connector/file ledgers above are operational telemetry;
they are not the invoice authority. Customer-rated usage is read from Ledger:

```http
GET /api/ledger/billing/usage?month=2026-07&groupBy=service
Authorization: Bearer <Nessie session>
```

The API accepts `groupBy=service|team|user`, requires an active-team owner or
admin, and verifies that the Nessie team maps exactly to the UOA organization
and team selected at SSO. It then calls Ledger server-to-server with:

- `LEDGER_BILLING_READ_APP_KEY_NESSIE`, a dedicated read-only key bound to the
  `nessie` product and carrying no provider grants;
- a fresh confidential UOA delegation whose exact scope is `billing.read`;
- the signed UOA organization/team as the query scope.

The billing key is never sent to the browser and must not equal or fall back to
the Nessie inference key (`LEDGER_PROXY_TOKEN` / `NESSIE_MODEL_API_KEY`).
Nessie's app key identifies the calling application only. UOA delegation
identifies the user/organization/team, while agent/run/tool provenance remains
a separate signed context on metered calls. Other applications must use their
own product-bound keys; webhook secrets are not app keys.

The schema-v4 response is content-free and preserves distinct views:

- raw provider usage in its real unit (`tokens`, `searches`, `researches`, and
  future service meters);
- billable equivalent units after the visible tariff multiplier;
- raw provider estimated/actual cost, billing base, added value, and customer
  charge without collapsing those amounts;
- per-currency customer totals and observed monthly subscription/tariff terms;
- an opaque immutable Ledger snapshot cursor.

The UI never adds unlike units together or describes searches/researches as
tokens. `service` and `user` groupings provide team-level and per-user views;
the `team` grouping explicitly echoes the one active signed team. Switching to
another team requires a matching UOA SSO workspace rather than widening a
delegation. Upstream auth failures surface as billing errors, not Nessie 401s,
so they cannot trigger session-refresh/logout loops.

## 11) Cross-links

- [functionality.md](./functionality.md)
- [organization-governance-spec.md](./organization-governance-spec.md)
- [language-and-translation-spec.md](./language-and-translation-spec.md)
- [audit-trail-spec.md](./audit-trail-spec.md)
- [shared-type-contracts-spec.md](./shared-type-contracts-spec.md)
- [policy-enforcement-spec.md](./policy-enforcement-spec.md)

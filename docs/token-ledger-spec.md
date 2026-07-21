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

## 10) Customer usage metering

The local Nessie token/connector/file ledgers above are operational telemetry;
they are not the invoice authority or a customer billing source. Ledger's
versioned raw-metering reader is restricted to UOA's dedicated billing-service
principal. Nessie has no Ledger billing-reader credential, customer metering
route, or parallel raw-metering panel. It never consumes the deprecated Ledger
schema-v4 billing response.

Nessie's builtin web search follows the same metering boundary. Agent,
delegated sub-agent, and workflow `web_search` calls use the Nessie app key
against Ledger's `/v1/serper/search`; Ledger alone injects the Serper credential
and records the raw search unit/provider cost. Every call carries signed
user/org/team/agent/run/tool-call provenance. Workflow jobs first bind the
queued actor context to the durable workflow actor and installation scope.
There is no direct `google.serper.dev` or `SERPER_API_KEY` fallback. The
corresponding Nessie `ConnectorUsageEvent` remains useful operational telemetry
but is not an invoice input and must never be rated locally. UOA queries
Ledger's strict raw contract for the signed billing period, product,
organization, and team, then produces the canonical statement below. That
statement is Nessie's only customer service/team/user usage and billing view.

### 10.1 SSO-owned commercial billing

Nessie does not create, edit, copy, cache, or calculate commercial tariffs and
does not hold Stripe customer, subscription, invoice, Price, statement,
adjustment, entitlement, or cancellation-intent state. UOA remains the sole
commercial authority and publishes the open protocol at
`GET /schemas/billing-statement-v2.json`. Active-team owners/admins use these
Nessie proxy endpoints:

- `GET /api/billing/statement`;
- `POST /api/billing/actions/upgrade`;
- `POST /api/billing/actions/portal`;
- `POST /api/billing/cancellation/preview`;
- `POST /api/billing/cancellation/confirm`.

The API resolves the exact linked UOA user/organization/team and rejects
local/UOA workspace drift. It then calls UOA with Nessie's dedicated
`UOA_BILLING_APP_KEY_NESSIE` and a fresh RS256
`X-UOA-Actor` whose subject, product, organization, and team exactly match the
request and whose lifetime is 45 seconds. This key is distinct from Nessie's
Ledger execution key and from every sibling product key.
UOA independently re-checks membership and billing-manager authority.

The consumer contract is the public MIT-licensed
`@unlikeotherai/billing-statement-protocol` 1.1.0 package authored by UOA.
Nessie vendors that package byte-for-byte from UOA commit
`205547b34bf01d5d665245cf622a193198997608`; the root lint gate verifies its
complete SHA-256 manifest. API responses and requests are validated with the
package's exported JSON Schemas, while the admin imports its exported view-model
types. Nessie must not keep an independently editable schema or type copy.

After a direct Nessie SSO token exchange has resolved and synchronized the
linked UOA workspace, the API calls UOA
`POST /billing/v1/service-access/confirm` with the exact
`nessie`/user/organization/team subject before issuing the local session. UOA
must return `204` with `Cache-Control: no-store`; otherwise login fails closed.
This seam is never called by connector, agent, DeepWater, workflow, or
background execution, so indirect usage cannot be mistaken for direct product
access during cancellation planning.

The version-2 statement is the complete customer view model: UOA supplies
display-ready money, plan and markup copy, commercial lines, totals,
per-service/per-user usage, access classifications, action labels, and disabled
reasons. Nessie displays those fields and never derives tariff or customer
charges. It may arrange rows, but does not sum, multiply, re-rate, rename money,
or decide action availability. Its `connected_service_usage` is derived by UOA
from the same single, exact Ledger `metering-portfolio-v1` `group_by=user`
snapshot used for rating. It includes every connected service's team total,
origin products, per-user usage, raw provider cost, and UOA-authored share
copy. Nessie validates the snapshot identity and renders those display fields
verbatim; it does not aggregate services or calculate percentages. Customer
actions and cancellation payloads remain on the frozen version-1 action
contract.

Cancellation is preview then confirm. UOA evaluates direct service access
across every user in the exact organization/team, relates only subscriptions
on the same account, distinguishes indirect Ledger use, and returns the exact
dialog copy and choices. A team that only used DeepWater through Nessie receives
no fabricated DeepWater cancellation choice; a team with any direct DeepWater
access receives UOA's cross-service choice. The preview token is opaque,
short-lived, single-use, subject-bound, and backed by locked state
revalidation/idempotency in UOA. Nessie relays only that token, the
UOA-generated idempotency key, and the selected UOA choice.

For Checkout, Portal, and cancellation preview, Nessie's API re-fetches the
canonical statement, permits only each frozen action-id/path pair, checks the
exact subject, and forwards UOA's server-produced request body unchanged.
Browser-supplied action bodies and return URLs are ignored or rejected. The
browser receives no UOA app key or actor assertion, and the API accepts no
arbitrary upstream path.

## 11) Cross-links

- [functionality.md](./functionality.md)
- [organization-governance-spec.md](./organization-governance-spec.md)
- [language-and-translation-spec.md](./language-and-translation-spec.md)
- [audit-trail-spec.md](./audit-trail-spec.md)
- [shared-type-contracts-spec.md](./shared-type-contracts-spec.md)
- [policy-enforcement-spec.md](./policy-enforcement-spec.md)

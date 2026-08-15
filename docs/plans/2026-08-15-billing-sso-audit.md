# Customer billing — audit against the UOA commercial-authority contract (2026-08-15)

> **Status:** assessment only — no product code changed. Evidence verified
> against the tree at `b3f39a16` (main). Every claim cites `file:line` actually
> read during the audit.

## The contract being assessed

UnlikeOtherAI (UOA) is the sole commercial authority: tariffs, statements,
credits, top-ups, subscriptions, adjustments, and the Stripe lifecycle live in
UOA. Ledger is the raw metering source and is UOA-only — products must hold no
metering-reader key, compute no tariffs/shares/credits, and persist no tariff,
Stripe customer/subscription/invoice, credit balance, top-up policy, payment
consent, add-on, statement, or cancellation state. Products render UOA's
display-ready models unchanged; every hosted/cancellation action is re-fetched,
validated by exact frozen action id/path/subject, and UOA's server-produced
body is relayed unchanged — browsers never supply action bodies or return
URLs. The public contract is the MIT-licensed
`@unlikeotherai/billing-statement-protocol` package, vendored byte-for-byte
with a SHA-256 manifest verification gate. Billing binds the exact linked UOA
user/org/team with a fresh short-lived RS256 actor assertion carrying the
session's UOA `tv` epoch; UOA independently rechecks billing-manager
membership. Managers see named-user/payment detail and frozen funding/add-on
actions; ordinary members get a privacy-safe read-only projection. Owner-only
local ops telemetry never renders beside customer billing.

---

## 1. Billing surfaces and what each renders

### 1.1 Customer surface — `/tokens` ("Credits & billing")

- **Route and nav.** `admin/src/router.tsx:321-322` mounts
  `TokenUsagePage` at `/tokens`; the sidebar item is
  `admin/src/layouts/admin-shell/AdminSidebarNav.tsx:324-331` ("Credits &
  billing", *not* `ownerOnly`, so members reach it). Checkout-return routing
  from `/` to `/tokens` preserving the full query:
  `admin/src/facades/billing/checkout-return.ts:38-45`.
- **Page.** `admin/src/pages/TokenUsagePage.tsx:63-86` renders three panels
  and nothing else: `UoaBillingCreditsPanel`, `UoaBillingRecurringAddonsPanel`,
  and — only when UOA's capability says `canReadStatement` —
  `UoaBillingStatementPanel` (`TokenUsagePage.tsx:26,84`). The page itself
  contains no local cost/pricing/budget component; that separation is pinned
  by a source-level test
  (`admin/test/billing-ops-boundary.test.ts:10-21`, asserting no
  `/api/ledger/`, `BudgetManager`, `PricingManager`, `Estimated Cost`, or
  `Monthly Projection` in the page source).
- **Credits panel.** `admin/src/components/features/billing/UoaBillingCreditsPanel.tsx`
  renders UOA's display-ready strings only: balance
  `display`/`label`/`description` (`:399-406`), pending/added/used
  (`:416-432`), conversion copy (`:435`), recent entries (`:203-228`), and
  manager-vs-member splits decided purely by UOA's `viewer.role`
  (`:20-23,134-137,189-192`): managers see named per-user rows
  (`:78-87`), auto-top-up status/threshold/cap (`:139-170`) and the frozen
  funding actions (`:233-375`); members see own/other/unattributed aggregates
  (`:95-132`), a payment-method-status-only auto-top-up notice (`:173-187`),
  and no funding actions (`:239` `if (!isManagerCredits(credits)) return null`).
- **Recurring add-ons panel.**
  `admin/src/components/features/billing/UoaBillingRecurringAddonsPanel.tsx:50-100`
  renders UOA's `title`, `description`, offer `name`/`description`,
  `monthly_price.display`, entitlement status, benefits; offer action buttons
  (subscribe/cancel) are gated on `data.viewer.role === 'billing_manager'`
  (`:92`).
- **Statement panel.**
  `admin/src/components/features/billing/UoaBillingStatementPanel.tsx:140-191`
  renders plan `display_name`/`markup_display`, `monthly_subscription.display`,
  subscription `display_status`, and per-currency `totals[*].total_due/…
  .display`; line items and service/access evidence come from
  `UoaBillingStatementDetails.tsx:163-181,190-` (all `.display` strings).
  Action buttons use UOA's `label`, `description`, `enabled`,
  `disabled_reason` (`UoaBillingStatementPanel.tsx:198-221`). The panel's own
  copy states "Nessie does not calculate commercial billing" (`:117`).
- **Cancellation dialog.**
  `admin/src/components/features/billing/UoaBillingCancellationDialog.tsx:78-79`
  renders UOA's `title`/`message`, UOA's choices (`:119-`), and submits only
  the UOA-issued `preview_token`, UOA's `confirm_action.idempotency_key`, and
  the user's `selection`
  (`UoaBillingStatementPanel.tsx:84-94`).

### 1.2 Ops surface — `/ops/usage` ("Operational usage"), owner-only

`admin/src/router.tsx:333-334` mounts `OperationalTelemetryPage`; the nav item
is `ownerOnly: true` (`AdminSidebarNav.tsx:346-355`). The page hard-gates on
`me?.user.roleIds.includes('owner')` (`OperationalTelemetryPage.tsx:113-117,
150-156` "Owner access required") and carries an explicit disclaimer that
customer balances/statements "are supplied by UOA on Credits & billing"
(`:178-186`). It renders Nessie-local telemetry from `/api/ledger/*`
(`:118-` …): token summaries, connector/file summaries, budgets
(`BudgetManager`), and model pricing (`PricingManager`). Server side, every
`/api/ledger` route is `requireOwner`-gated (`api/src/routes/ledger.ts:34,
39,66,84,98,118,132,141,150,179,192,223,232,252`). The boundary test
(`admin/test/billing-ops-boundary.test.ts:23-39`) pins both directions.
**Customer billing never renders beside ops telemetry** — the two pages share
no component.

### 1.3 API surface

`api/src/routes/billing.ts` registers 15 endpoints, all behind
`requireActorContext` and all `Cache-Control: private, no-store`
(`:63-76,78-91,93-106,108-128,130-196,198-212,214-237,239-267,269-295,
297-316,318-341,343-360,362-389`): capability, credits, recurring-addons
reads; top-up/auto-top-up setup/select/disable/recover; add-on subscribe and
cancellation preview/confirm; statement; hosted actions `upgrade`/`portal`;
cancellation preview/confirm. The route layer is a thin pass-through to
`api/src/services/uoa-billing-*.ts`.

---

## 2. Team scoping and workspace-switch behavior

**The billing subject is the session's signed UOA identity, cross-checked
against the active local team on every call.**

1. `createUoaBillingClient` (`api/src/services/uoa-billing-client.ts:382-402`)
   resolves the workspace per request via `resolveBillingWorkspace`
   (`api/src/services/billing-workspace.ts:39-129`):
   - requires a user actor with `uoaIdentity` present and non-null
     `tokenVersion`, else `BILLING_SSO_REQUIRED` (`:46-59`);
   - loads the `(organizationId, userId, 'nessie')` `ProductAccountLink` and
     the active team (`:61-92`);
   - **fails closed on mismatch**: link `status === 'linked'`, and
     `identityLink.uoaSub === sessionIdentity.subject`,
     `identityLink.uoaTokenVersion === sessionIdentity.tokenVersion`,
     `sessionIdentity.organizationId === team.externalOrgId`, and
     `sessionIdentity.teamId === team.externalWorkspaceId`, else
     `BILLING_CONTEXT_MISMATCH` (409) (`:93-114`). The statement/credits view
     is therefore bound to the **exact linked UOA user/org/team**, not to
     ambient local tenancy.
2. The subject sent to UOA is exactly that verified session identity
   (`uoa-billing-client.ts:395-401`), and every read re-validates UOA's
   response subject against it (`uoa-billing-statement.ts:63-69` for the
   statement, incl. period; `uoa-billing-funding.ts:51-63,74-81,93-100` for
   credits/add-ons).
3. **On a workspace switch** the browser hits `POST /api/auth/uoa/workspace`
   (`api/src/routes/auth-uoa-workspace.ts:47-`), which consumes the refresh
   family with `uoaWorkspaceSwitch` callbacks; before the source credential is
   presented, `confirmUoaWorkspaceSwitchAccess`
   (`api/src/services/uoa-workspace-switch.ts:51-73`) calls UOA's
   `/billing/v1/service-access/confirm` for the **target** org/team
   (`uoa-billing-client.ts:404-431`), so UOA re-proves direct Nessie access in
   the target workspace before the session's `uoaIdentity` (and its `tv`)
   advance. A cross-org switch also runs the target-org account-link sync
   (`uoa-workspace-switch.ts:145-165`).
4. Client-side, stale projections cannot cross a switch: the capability query
   key includes user/org/team/session (`admin/src/facades/billing/hooks.ts:
   37-43`), and credits/add-ons/statement keys embed UOA's returned scope
   tuple **including `tokenVersion`** (`hooks.ts:45-69`), with
   `staleTime: 0`, `retry: false`, `refetchOnWindowFocus: false`
   (`:80-87,93-102,108-117,208-217`). A comment states the intent
   (`:71-75`) and `admin/test/uoa-billing-context-cache.test.ts:24-43` proves
   a team-A manager projection is never served for team B and that the epoch
   is part of every key. Checkout returns trigger an exact-key refetch of
   credits/add-ons/statement (`TokenUsagePage.tsx:32-53`).

---

## 3. Local persistence or computation of commercial values

**Customer commercial state: none found.**

- The Prisma schema contains no tariff, Stripe customer/subscription/invoice,
  credit-balance, top-up-policy, payment-consent, add-on, statement, or
  cancellation model. The only billing-adjacent persisted rows are the UOA
  identity link (`ProductAccountLink.uoaSub`, `uoaTokenVersion`,
  `activeOrgId`/`activeTeamId` as "last-seen UI metadata" —
  `api/prisma/schema.prisma:1056-1079`) and team external mappings. Schema
  searches for `stripe|tariff|credit|invoice` hit only unrelated models
  (`CommsSubscription`, `WebPushSubscription`).
- The billing services perform no writes at all — they use a Prisma pick of
  only `productAccountLink` and `team`
  (`uoa-billing-funding.ts:46-49`, `uoa-billing-statement.ts:50-53`,
  `billing-workspace.ts:11-14`) and contain no `create/update/upsert`.
- No computation of money/shares/credits: UI and API pass through UOA's
  `.display` strings (§1). DeepWater tooling even hard-codes the rule that
  products must not pass cost/price/charge/tariff/currency toward Ledger
  (`api/src/routes/integrations/handoff-builders.ts:88`). No metering-reader
  key exists: billing egress uses only the UOA app key + actor JWK
  (`uoa-billing-client.ts:19-25`), and `X-UOA-Actor`/`X-UOA-App-Key` appear
  only in that one client.

**Ops telemetry (deliberately separate, but a caveated zone — see §6 P2):**
Nessie *does* persist locally computed operational cost figures:
`TokenLedgerEvent.estimatedCostAmount` (`api/prisma/schema.prisma:3460`,
documented at `:3416-3418` as surviving org deletion "for billing / audit
retention"), `ModelPricingProfile` CRUD (`api/src/services/pricing-profiles.ts:
24-78`), and monthly-projection aggregation (`api/src/services/token-ledger.ts:
105,140,155,201,209,223`). Per the estate contract these are owner-only ops
telemetry (budgets, internal cost estimation), not customer billing, and the
`/tokens` vs `/ops/usage` split keeps them off member surfaces
(`admin/test/billing-ops-boundary.test.ts`); `docs/functionality.md:782,784`
documents the split explicitly. They are flagged in §6 because the contract
text bars products from "computing tariffs" and persisting commercial state —
the line this codebase draws (internal estimates never rendered to members,
never fed to UOA) is defensible but is an interpretation.

---

## 4. Protocol package version, vendoring, and the SHA gate

- The contract package is vendored in-tree at
  `packages/billing-statement-protocol/`, version **1.2.0**, license MIT
  (`packages/billing-statement-protocol/package.json:2-5`), consumed by both
  api and admin as `workspace:*` (`api/package.json:44`,
  `admin/package.json:33`) — no parallel contract elsewhere; the only
  Nessie-side billing schemas are two tiny response envelopes in
  `packages/schemas/src/uoa-billing-actions.ts` and the capability envelope in
  `packages/schemas/src/uoa-billing-capability.ts` (see §6 P2 for why those
  are flagged anyway).
- The SHA-256 manifest gate **exists**:
  `packages/billing-statement-protocol.upstream.sha256` pins every file
  (header `# UnlikeOtherAuthenticator@698765f`), and
  `scripts/verify-billing-protocol-vendor.mjs:36-75` fails on any unexpected
  file, checksum mismatch, or missing file.
- The gate is **wired into the mandatory lint chain**:
  `package.json:11-12` — `"lint": "pnpm verify:billing-protocol && …"` — and
  CI's lint job runs `pnpm lint` (`.github/workflows/ci.yml:36`), while the
  lint-gated root build (`package.json:19`) runs it too. A tampered vendored
  package cannot pass lint, typecheck (which builds the package first,
  `package.json:18`), or build.

---

## 5. Actor assertion, epoch handling, and manager-vs-member projection

- **Assertion.** Every UOA billing call goes through `requestBilling`
  (`api/src/services/uoa-billing-client.ts:286-354`): a fresh RS256 JWT per
  call (`signBillingActor`, `:211-241`) with `iss` = this API's public origin,
  `sub`/`organisation_id`/`team_id`/`tv` from the verified session identity,
  `exp = iat + 45s` (`:25`), unique `jti`, sent as `X-UOA-Actor` alongside
  the deployment app key `X-UOA-App-Key` (`:306-312`, key format-enforced
  `uoa_app_…` at `:179`). Egress is IP-pinned `safeFetch` with
  `maxRedirects: 0` (`:302-320`). Path allow-list: only `/billing/v1/*` and
  `/billing/v2/customer-statement`, exact-path/origin checked, no query/hash
  (`:253-272`). Upstream 401/403 map to reauth/forbidden; only
  400/404/409/410/422/503 statuses are relayed, everything else becomes 502
  (`:329-352`).
- **Epoch.** `tv` is bound into the assertion (`:229`) and pre-verified
  against the durable link (`billing-workspace.ts:104-109`); the capability
  service refuses to report a scope without an epoch
  (`uoa-billing-capability.ts:50-53`). UOA rechecks manager membership —
  Nessie derives `canManageBilling` solely from UOA's returned `viewer.role`
  (`uoa-billing-capability.ts:23-26`, comment `:36-39` "Local organisation
  roles must not be used for either purpose").
- **Member projection.** Server-side, manager-only mutations refuse in words
  for non-managers (`uoa-billing-funding.ts:117-147`), and the statement is
  exposed only when UOA's capability allows (route
  `api/src/routes/billing.ts:297-316` gated client-side by
  `canReadStatement`, `hooks.ts:208-217`, `TokenUsagePage.tsx:26,84`).
  Client-side rendering splits on the protocol's visibility schema
  (manager vs member variants at
  `packages/billing-statement-protocol/src/credits-visibility-schema.ts:249,
  287`, member "viewer / other_team_members / unattributed" buckets at `:75,
  82,168`) as detailed in §1.1.
- **Frozen actions.** Re-fetched per execution, exact id/kind/method/path/
  body matched (`uoa-billing-action.ts:33-72`), disabled actions refuse with
  UOA's `disabled_reason` (`:64-70`). Browsers supply only path parameters
  (`offerId`, `optionId`, `subscriptionId`) or UOA-minted opaque tokens
  (`preview_token`, `idempotency_key`, `choice`/`selection`) — request bodies
  on action routes are `EmptyBodySchema` (`billing.ts:28,108-128,…`) or the
  protocol's own confirm-request schema (`billing.ts:365`,
  `uoa-billing-protocol.ts:107-110`). No browser-supplied return URLs exist
  anywhere (`return_url|success_url|cancel_url` have zero hits); the only
  return marker is the fixed `uoa_billing` query parameter rendered as a
  neutral notice (`checkout-return.ts:1-34,47-55`). Stripe redirect URLs are
  host-pinned (`checkout.stripe.com` / `billing.stripe.com`,
  `uoa-billing-redirect.ts:6-31`) and the hosted-action flow re-fetches the
  statement, validates the frozen action, relays UOA's exact body, and
  re-parses the upstream response (`uoa-billing-statement.ts:123-162`).

---

## 6. Consistency gaps vs the contract, prioritized

### P1 — Actor-assertion audience is pinned to a single endpoint

`aud` is fixed to `${UOA_BASE_URL}/billing/v1/effective-tariff`
(`api/src/services/uoa-billing-client.ts:199,224`) yet the same assertion is
sent to `/billing/v2/customer-statement`, the credits and recurring-addons
paths, the Stripe session paths, and cancellation paths
(`uoa-billing-statement.ts:33-48`, `uoa-billing-funding.ts:65-101`). If UOA
verifies `aud` per-endpoint (standard RS256 audience semantics), every call
except `effective-tariff` (which Nessie never calls) should be rejected; if
UOA accepts it, the assertion is effectively unscoped and a captured token is
replayable across the whole billing API within its 45-second TTL — contrary
to the "fresh short-lived actor assertion" intent. Either way the audience is
wrong or meaningless. **Impact is mitigated** by the 45 s TTL, per-call `jti`,
IP-pinned egress, and UOA-side membership recheck, but this is the one place
where the implementation visibly diverges from the assertion contract.

### P2 — Interpretation risks worth a deliberate, written decision

1. **Locally computed and persisted cost money.** Nessie stores per-million
   pricing rates (`ModelPricingProfile`,
   `api/src/services/pricing-profiles.ts:24-78`) and computes/persists
   `estimatedCostAmount` per ledger event plus monthly projections
   (`api/prisma/schema.prisma:3460`, `api/src/services/token-ledger.ts:105-155,
   201-223`). The schema comment itself says ledger rows survive org deletion
   "for billing" (`schema.prisma:3416-3418`). The contract bars products from
   computing tariffs/shares/credits and persisting commercial state; Nessie's
   defence is that these are owner-only *operational estimates* with an
   explicit "not customer credits, a tariff, or an invoice" disclaimer
   (`admin/src/pages/OperationalTelemetryPage.tsx:178-186`), never rendered to
   members, never sent to UOA, and enforced separate by
   `admin/test/billing-ops-boundary.test.ts`. That defence should be confirmed
   with UOA in writing — "estimate of provider cost for ops" vs "tariff
   computation" is exactly the ambiguity the contract wording creates.
2. **A second, hand-maintained checkout/portal schema.** The protocol package
   contains no checkout-session/portal-session response schema (searches of
   `packages/billing-statement-protocol/src` and `schema/` find only the
   action paths inside fixture strings), so Nessie hand-writes
   `UoaBillingCheckoutResponseSchema`/`UoaBillingPortalResponseSchema` in
   `packages/schemas/src/uoa-billing-actions.ts:28-41` — including a full
   `CheckoutTariffSchema` (`:6-26`) that duplicates tariff field definitions
   (`markup_bps`, `monthly_subscription`, …) presumably defined by UOA
   elsewhere. This is a small **parallel billing contract** in the sense the
   vendoring rule exists to prevent; if UOA changes the checkout payload
   shape, nothing but runtime parse failure detects it. The clean fix is for
   UOA to publish these envelopes in the protocol package; until then the
   strict `.strict()` schemas plus `invalidUoaBillingResponse` 502s
   (`uoa-billing-statement.ts:136-161`) at least fail closed.
3. **Member read of statement is owner/admin-gated locally, in tension with
   "UOA decides".** `canReadStatement` is set to `canManageBilling`
   (`uoa-billing-capability.ts:25-26`) — i.e. *Nessie's UI policy* hides the
   statement from ordinary members even if UOA would serve them a
   privacy-safe statement projection. This is a narrowing choice, not a leak
   (UOA's role remains the authority for `canManageBilling`), and it matches
   the documented behavior table (`docs/functionality.md:782` "statement and
   mutations: active-team owner/admin"), but it is Nessie, not UOA, deciding
   who sees a statement route that technically sits behind only
   `requireActorContext` (`api/src/routes/billing.ts:297-316` — any
   authenticated linked member can call it; the server does not re-check the
   role for the statement read). Net effect: the gate is advisory UI, the
   server would serve whatever UOA returns. Either let UOA's own 403 be the
   gate (simplest, contract-aligned) or enforce the intended policy
   server-side.

### P3 — Minor / hygiene

1. **Action-body comparison is strict-equality based.**
   `hasExactUoaActionBody` (`api/src/services/uoa-billing-action.ts:15-24`)
   compares with `===`, correct for today's flat string bodies; a future
   nested/array body field would silently fail validation (fail-closed, so
   safe, but it will surface as `UOA_BILLING_ACTION_INVALID` 502s rather than
   a schema error). The protocol's AJV schemas do validate the *shape*
   (`uoa-billing-protocol.ts:29-63`), so the frozen-body equality check is
   the only weak comparator.
2. **No cancellation-state cache on the client.** Cancellation previews are
   held in component state only (`UoaBillingStatementPanel.tsx:58-61`); a
   remount loses a `preview_token`. Not a contract violation — tokens are
   single-purpose and re-fetchable — noted for completeness.
3. **`confirmUoaDirectServiceAccess` duplicates the 204/no-store check** of
   `postNoContent` (`uoa-billing-client.ts:364-379` vs `:421-430`) — two
   copies of one invariant; harmless, but the repo's no-fork rule would put
   it in one function.

### Verified non-gaps (checked and clean)

- No Stripe SDK, no metering-reader key, no product-side Stripe state (§3).
- No local persistence of any UOA billing payload (§3).
- Byte-for-byte vendoring with an enforced SHA-256 gate in lint/CI/build (§4).
- Exact-subject re-validation of every UOA read response (§2).
- Re-fetch + frozen-action validation on every hosted/cancellation action;
  browsers never supply action bodies or return URLs (§5).
- Workspace switch re-proves target access with UOA before rebinding, and
  cache keys make stale cross-team projections unreachable (§2).
- Owner-only ops telemetry is navigationally, visually, and server-side
  (`requireOwner`) separate from customer billing (§1.2).

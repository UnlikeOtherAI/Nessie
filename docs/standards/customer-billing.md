# Customer billing stays in UOA

Authoritative standard, moved verbatim out of [`AGENTS.md`](../../AGENTS.md)
so it is read when the work touches this area rather than loaded into every
session. `AGENTS.md` carries the one-line invariant and points here; **this
file is the rule**.

- Customer tariffs, statements, credits, top-ups, subscriptions, adjustments,
  and Stripe
  lifecycle remain authoritative in UOA. Ledger's raw reporting endpoint is
  UOA-only: Nessie must not hold a metering-reader key, call Ledger's legacy
  billing route, or expose a parallel raw-billing panel. Nessie's product-bound
  Ledger app key is only for its paid inference, DeepWater, Serper, and other
  metered execution calls; UOA independently reads Ledger and supplies the
  customer-facing service/team/user breakdown. The canonical UOA customer
  statement, Checkout, Portal, and
  cancellation preview/confirm use a different, Nessie-only
  `UOA_BILLING_APP_KEY_NESSIE` plus a fresh 45-second RS256 actor assertion
  signed by `UOA_BILLING_ACTOR_PRIVATE_JWK_NESSIE`. Both secrets are
  cryptographically validated on the Actions runner, then installed together by
  a dependency-free host script in the main-branch deployment workflow; neither
  may be reused by Ledger or a sibling product. The actor assertion carries the
  signed session's UOA `tv` epoch—not a value recovered from a mutable account
  link—for UOA's online credential-revocation check. Every request resolves the exact
  linked UOA user/org/team, rejects local team drift, and lets UOA
  independently recheck billing-manager membership. The public
  protocol is consumed from the MIT-licensed
  `@unlikeotherai/billing-statement-protocol` 1.2.0 package, vendored
  byte-for-byte from UOA commit
  `272e4d95846788f752d1e623d5f69f7c961f1dc5` and protected by a root SHA-256
  verification gate. API validation uses its exported JSON Schemas and the
  admin imports its exported view-model types; local editable copies are
  forbidden. `/schemas/billing-statement-v2.json` is display-ready: Nessie
  renders its plan, markup, line items, totals, and the complete
  connected-service team/origin/user portfolio from one exact Ledger
  `metering-portfolio-v1` `group_by=user` snapshot without rating, aggregation,
  share calculation, or cancellation reasoning. Frozen customer actions remain
  on the version-1 action contract. For actions the API re-fetches the statement,
  accepts only the
  frozen action-id/path pair, verifies its subject, and forwards UOA's
  server-produced body unchanged. Browser-supplied action bodies and return URLs
  are forbidden. Cancellation relays only UOA's opaque short-lived preview
  token, UOA idempotency key, and selected UOA choice; UOA locks and revalidates
  team-wide direct access before confirming. Nessie stores no tariff, Stripe
  customer, subscription, invoice, Price, credit balance, top-up policy,
  payment consent, recurring add-on, statement, or cancellation state. Every
  active exact-team member may read the same UOA-owned team credit account.
  The display leads with remaining credits, then pending/added/used credits,
  connected-service usage, recent activity, and automatic top-up status. UOA
  fixes 1,000 credits to US$1 and returns display-ready values; Nessie never
  converts tokens, raw Ledger units, provider cost, or money into credits.
  Billing managers receive named-user/payment detail and frozen top-up,
  automatic-top-up, and recurring-add-on actions. Ordinary members receive a
  privacy-safe read-only projection with their own usage plus anonymous
  other-member and unattributed totals. Their pending-payment amount and
  funding policy are absent; automatic top-up exposes only UOA's payment-method
  status and directs detailed settings to billing managers. Every mutation
  re-fetches the UOA view,
  validates the exact frozen action, and relays it unchanged.
  `/tokens` is the customer Credits & Billing surface and contains only these
  UOA-authored models. Nessie's owner-only local token, pricing, estimate,
  projection, connector, file, and budget telemetry is isolated at
  `/ops/usage`; it must never be rendered beside customer credits or statements.
  Integrated-product APIs do not query or return local usage summaries.
  A successful direct Nessie SSO exchange confirms `nessie` access through
  UOA's exact `/billing/v1/service-access/confirm` seam before Nessie issues its
  local session; the call is bound to the linked user/org/team and fails login
  closed unless UOA returns `204` with `no-store`. Connector, DeepWater, agent,
  and other indirect execution paths never create this direct-access evidence.

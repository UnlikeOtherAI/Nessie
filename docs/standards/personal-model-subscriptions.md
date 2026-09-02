# Personal model subscriptions — the owner's plan, the owner's grant

Authoritative standard, moved verbatim out of [`AGENTS.md`](../../AGENTS.md)
so it is read when the work touches this area rather than loaded into every
session. `AGENTS.md` carries the one-line invariant and points here; **this
file is the rule**.


A person links a consumer AI plan they already pay for (Kimi and GLM today;
OpenAI Codex and xAI Grok when the OAuth phase lands) and the agents **they
own** run on it instead of the organization's Ledger credits. Rules that must
not drift:

- **A link is Nessie's own grant.** Never read, import, or accept a vendor
  CLI's stored credentials (`~/.codex/auth.json`, `~/.grok/auth.json`, keychain
  items): providers rotate refresh tokens and invalidate the previous one, so
  two apps sharing one grant log each other out. One grant, one refresh owner.
- **Token values live in the vault, never in PostgreSQL**, in a **dedicated,
  separately-ACLed** vault project (`NESSIE_SUBSCRIPTION_VAULT_*`) rather than
  the shared personal partition, which also holds a person's ordinary captured
  secrets. `model_subscription_credentials` holds only the pointer, and a
  deployment with no vault refuses linking in words — never a column fallback.
  Deleting a pointer tombstones the vault secret in the same transaction, or a
  cascade strands a live refresh token nothing can address.
- **The lane is pinned at run admission and never falls back.**
  `resolveRunSubscriptionBinding` re-derives entitlement from live rows and
  persists the subscription plus its credential epoch on the `Run`, so a
  mid-run relink cannot switch accounts and a continuation whose binding died
  fails closed. Anything that merely *looks* like a subscription — unknown
  adapter, dangling pointer — is `unavailable`, never Ledger: falling back
  would move a person's spend onto the organization with nobody agreeing to it.
- **Organization budgets gate organization spend, so they do not gate this
  lane.** `applyBudgetGate` and its mid-run probe skip a pinned run: blocking
  would refuse a run the organization is not paying for, and a `degrade`
  verdict would rewrite it onto the organization's Ledger provider — moving the
  very spend it was capping. The per-run backstop envelope still applies.
- **Exclusion from cost is structural**: `TokenLedgerEvent.billingSource` +
  `modelSubscriptionId` decide it, never the absence of a pricing profile.
  Attribution follows the subscription **owner**, not whoever posted, and the
  writer reads the run's own pin so no terminal path can forget to stamp it.
- **One validator, every write path.** `assertAgentModelSelection`
  (`@nessie/workspace-admin`) gates create, update, clone and the PA
  `agent_create` tool; ownership transfer and clone strip the selection,
  because a subscription is not transferable. Write-time validation is UX; the
  run-time gate is the security boundary.
- **Refresh discipline:** a short locked claim, the network call outside any
  transaction, compare-and-swap on the epoch, never a transport-failure retry
  of a refresh grant, a 5-minute proactive margin, and failure transitions
  applied only while the failing epoch is still current. Only adapter-defined
  authentication codes reach `needs_reauthorization` — 403 is also entitlement,
  policy and quota, which a relink button cannot fix.

Rationale, field lessons and phasing:
[docs/plans/2026-09-02-personal-model-subscriptions.md](../plans/2026-09-02-personal-model-subscriptions.md).

## Detail

Moved verbatim out of [`CLAUDE.md`](../../CLAUDE.md) → "Personal model subscriptions — run your own agents on your own plan".


A person links a plan they already pay for and the agents **they own** run on
it instead of the organisation's Ledger credits. Phase 1 ships Kimi and GLM
(pasted subscription keys); OpenAI Codex and xAI Grok arrive with the
device-code OAuth phase. Anthropic is deliberately excluded — subscription
credentials are not licensed for third-party agent platforms, and Nessie
already serves Claude through Ledger. The invariants (own grant never a CLI
import, vault-only token storage in a dedicated project, run-admission pinning
with no Ledger fallback, budget gates skipped, structural `billingSource`, one
shared validator, the refresh/epoch discipline):
[docs/standards/personal-model-subscriptions.md](personal-model-subscriptions.md).
Spec:
[docs/plans/2026-09-02-personal-model-subscriptions.md](../plans/2026-09-02-personal-model-subscriptions.md).

Facts not restated there:

- **Two egress lanes, never a proxy.** A subscription run opens no Ledger
  connection at all — `resolveStageProviderConfig` short-circuits the whole
  deployment/organisation chain and returns the adapter's own base URL and the
  person's token. Signing needs no special case: the effective URL is not a
  Ledger origin, so `createProviderRequestHeadersResolver` already declines to
  attach `X-Nessie-Context`/`X-UOA-Delegation`.
- **Generative inference only.** Main turns, delegates, compaction and
  checkpoint notes follow the run's lane. Engagement decisions (made on the
  boot-time model client before a run exists), embeddings and memory, avatar
  generation, and demonstration generalisation stay deployment-billed — a
  "subscription-only" agent still produces some Ledger events by design.
- **Utility model is explicitly null** for a subscription run, not a lookup
  miss: `NESSIE_UTILITY_MODEL` names a Ledger-catalogue model a subscription
  backend may not serve.
- Package `@nessie/model-subscriptions` (adapters, vault store, coordinator);
  routes `/api/model-subscriptions*`; surfaces are the "Personal model
  subscriptions" section on `/settings/connections` and the **Your
  subscriptions** group in the Agent Designer model picker, which also carries
  the "Link a personal subscription…" doorway when none is linked.
- Vault configuration is `NESSIE_SUBSCRIPTION_VAULT_API_URL` /
  `_TOKEN` / `_PROJECT_ID` (+ optional `_ENVIRONMENT`). Unset ⇒ the settings
  section says the feature is unavailable and linking is refused.

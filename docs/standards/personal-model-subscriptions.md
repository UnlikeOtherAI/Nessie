# Personal model subscriptions — the owner's plan, the owner's grant

Authoritative standard, moved verbatim out of [`AGENTS.md`](../../AGENTS.md)
so it is read when the work touches this area rather than loaded into every
session. `AGENTS.md` carries the one-line invariant and points here; **this
file is the rule**.


A person links a consumer AI plan they already pay for — Kimi and GLM with a
pasted console key, **OpenAI Codex and xAI Grok with Nessie's own device-code
sign-in** — and the agents **they own** run on it instead of the
organization's Ledger credits. Rules that must not drift:

- **A link is Nessie's own grant.** Never read, import, or accept a vendor
  CLI's stored credentials (`~/.codex/auth.json`, `~/.grok/auth.json`, keychain
  items): providers rotate refresh tokens and invalidate the previous one, so
  two apps sharing one grant log each other out. One grant, one refresh owner.
- **Device-code linking is server-side, leased, and confirmed.** The token
  exchange happens on the server, so no credential passes through the browser.
  Polling holds one lease per state row and honours the provider's own interval
  and `slow_down`, because several tabs or replicas hammering a shared public
  client would get it throttled for everyone. And a first link parks its
  credential in the vault under a pending name until the person confirms WHICH
  account signed in — that confirmation is the whole defence against the
  device-flow confused deputy, where somebody else enters your code and their
  account would otherwise be attached to your team silently. A relink
  binds the `providerAccountId` already on the row and refuses a different one.
- **An id_token is read strictly, and a grant without a refresh token is
  refused.** Exact issuer, audience equal to the client id, expiry, and a
  stable subject, all fail-closed — a relink's account match is only as good as
  this reading. A response carrying no `refresh_token` is refused at link time
  rather than working until the first expiry and then dying silently.
- **Vendor client ids are the vendor's own public clients**, and Nessie says so
  rather than impersonating their CLI: OpenAI's flow carries
  `originator=nessie`, and xAI's consent screen may name "Grok Build" because
  the client is shared — the linking copy tells the person that. Every endpoint
  xAI's discovery document names must be on `x.ai`, or the device grant is
  refused.
- **Codex speaks the Responses API**, not chat/completions, through its own
  `codex-subscription` connector (`store: false`, so a team's content
  never lands in a person's ChatGPT history). Its deltas map onto the same
  `output_text.delta` / `tool_call.delta` / `reasoning_text.delta` vocabulary
  every other connector emits, so the agentic loop, the thinking recorder and
  live document streaming see nothing new; a tool-call fragment is enriched
  from the accumulated call, never the chunk carrying it. Adapter transport
  headers travel on `ModelProviderConfig.extraHeaders`, which only code
  populates — never a caller, a stored record, or a model.
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
  (`@nessie/team-admin`) gates create, update, clone and the PA
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
shared validator, the refresh/epoch discipline): stated above.
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

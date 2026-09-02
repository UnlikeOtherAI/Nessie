# Personal model subscriptions — run your own agents on your own plan

**Status: phase 1 BUILT (2026-09-02) — Kimi + GLM linking, routing, budgets,
metering and surfaces are on `main`. Phase 2 (Codex + Grok device-code OAuth)
and phase 3 remain proposed.**

What shipped in phase 1: the `@nessie/model-subscriptions` package (adapters,
vault-backed secret store, credential coordinator), the four Prisma tables plus
`Agent.modelSubscriptionId`, the `Run` lane pin and
`TokenLedgerEvent.billingSource`; the run-admission binding with fail-closed
routing, the budget-gate and mid-run-probe skips, the explicit-null utility
model, and owner-attributed metering; `assertAgentModelSelection` as the one
validator across create/update/clone/PA-create with transfer and clone
stripping the selection; `/api/model-subscriptions*` routes; and the settings
section plus the Designer's "Your subscriptions" group and link doorway.
Deliberately deferred with phase 2: the per-subscription concurrency lease and
the health-sweep alert (§4 phase 3).

A person who already pays for a consumer AI subscription — OpenAI Codex
(ChatGPT Plus/Pro), Kimi for Coding, a GLM coding plan, Grok — links it to
Nessie once, and the agents *they own* can run on it. After linking, the Agent
Designer model dropdown grows a **"Your subscriptions"** group beside the
Ledger catalogue. The organisation's Ledger billing is untouched: these runs
spend the person's own plan, not org credits.

**Anthropic is deliberately excluded.** Claude subscription credentials are
not licensed for third-party agent platforms, and Nessie already serves
Anthropic models through Ledger. No adapter, no exception.

---

## 1. What exists today (verified against the code)

- **Inference resolution is deployment-first.** `createRunInference`
  (`worker/src/run/execute/run-inference.ts`) is the single construction point
  for every inference a run makes. It flows through `buildDirectRoute`
  (`worker/src/run/inference.ts`) → `resolveStageProviderConfig`
  (`worker/src/run/inference-provider.ts`), where
  `baseUrl = modelConfig.baseUrl ?? providerRecord?.baseUrl` — the deployment
  env (`NESSIE_MODEL_BASE_URL`, normally Ledger) always wins, precisely so an
  agent selection cannot bypass metering or signed attribution. Org
  `InferenceProvider` records are org-scoped, their credentials are env refs
  (new caller-chosen refs are refused), and nothing is user-scoped anywhere in
  the inference schema.
- **Signing already keys off the effective URL.**
  `createProviderRequestHeadersResolver`
  (`worker/src/run/inference-identity.ts`) returns `undefined` for any
  non-Ledger base URL, so `X-Nessie-Context` / `X-UOA-Delegation` never follow
  a request to a third-party host. Same discipline as the embedding override.
- **The model dropdown is the Ledger catalogue for everyone.**
  `GET /api/agents/models` → `listLedgerAgentModels`
  (`packages/workspace-admin/src/ledger-agent-model-catalog.ts`);
  `assertLedgerAgentModelSelection` gates agent create/update to an exact
  `(provider, model)` pair from that list. Validation is write-time only — the
  run path never re-validates.
- **Per-user encrypted credentials have one proven pattern.**
  `CommsConnection` + separate `CommsConnectionCredential` table (token
  material never beside metadata), AES-256-GCM packed columns via
  `sealSecret`/`openSecret` over `deriveSecretKey(NESSIE_AUTH_SECRET)`
  (`packages/runtime/src/secret-crypto.ts`), pg-backed one-shot OAuth state
  (`comms_oauth_states`), and refresh serialized under a `FOR UPDATE` row lock
  with a structural `needs_reauthorization` transition
  (`packages/workspace-admin/src/comms-credential-coordinator.ts`).
- **Connectors:** `packages/runtime/src/inference/connectors/` has
  `openai`/`openai-compatible` (chat/completions), `kimi` (Anthropic Messages,
  default direct base `https://api.kimi.com/coding`), `deepseek`. Nothing
  speaks the OpenAI **Responses** API. The registry has a `register()`
  extension point; a new provider name also needs the `ModelProviderName`
  literal (`inference/types.ts`), a `resolveRuntimeProvider` branch, and a
  `DEFAULT_MODELS` entry.
- **Metering:** every invocation writes a `TokenLedgerEvent`;
  `estimatedCostAmount` comes only from `ModelPricingProfile` and is `null`
  without one, so cost budgets see 0 while token budgets still meter.
- **Desktop:** the Tauri shell registers the `nessie://` deep-link scheme with
  a hardened external-auth callback hub
  (`admin/src/providers/ExternalAuthProvider.tsx`,
  `external-auth-completion.ts`), can open the system browser
  (`tauri-plugin-opener`), and has **no** localhost HTTP listener today.
- **Codex precedent:** the executor's guest-VM Codex integration
  (`executor/src/`, `CODEX_EGRESS_ORIGINS = ['https://chatgpt.com']`)
  deliberately keeps the ChatGPT login on the user's machine. This feature is
  the opposite, explicit choice: the person knowingly hands Nessie their
  subscription tokens so *server-side* agents can spend them. The linking UI
  must say exactly that.

## 2. Shape of the feature

### 2.0 Reference implementation: replicate OpenClaw, don't reinvent

**Decision (Ondrej, 2026-09-02): replicate what OpenClaw does.** It runs
these exact flows for millions of users; its auth layer has already absorbed
the field failures (rotation races, burned refresh tokens, consent-screen
quirks, `slow_down` polling, Cloudflare challenges) that a fresh design would
rediscover one incident at a time. The sibling checkout at
`/Volumes/External/Projects/OpenClaw` (keep it pulled to origin/main) is the
reference; where this plan and OpenClaw disagree on a *mechanism*, OpenClaw
wins unless a Nessie invariant (tenancy, disclosure, encrypted-at-rest
storage) forces the difference. Concretely:

- **Flows, endpoints, client ids, and vendor-specific parameters are copied
  from OpenClaw's extensions, not re-derived** — e.g. OpenAI's
  `id_token_add_organizations=true` + `codex_cli_simplified_flow=true` +
  `originator` params, xAI's OIDC discovery + trusted-host check +
  `slow_down` handling, the per-provider token-failure reason tables.
  Reference files: `extensions/openai/openai-chatgpt-oauth-*.runtime.ts`,
  `extensions/openai/openai-chatgpt-device-code.ts`,
  `extensions/xai/xai-oauth.ts`, and the shared primitives in
  `src/plugin-sdk/provider-oauth-runtime.ts`.
- **Refresh semantics are copied wholesale** from
  `src/agents/auth-profiles/oauth-manager.ts` + `oauth.ts`: single refresh
  owner, re-read-inside-the-lock adoption, the lock-timeout-vs-stale
  invariant, the `refresh_token_reused` recovery ladder, the 5-minute
  proactive margin, no transport-failure retry of refresh grants (§2.5).
- **What deliberately differs:** storage (token values in the deployment's
  Infisical vault with metadata-only Postgres rows, instead of per-agent
  SQLite; the server is the one refresh owner), tenancy (rows scoped
  `(organizationId, userId)`), and surface (the admin settings page instead
  of a CLI). Behaviour at the provider boundary stays byte-alike.
- **License check before porting code verbatim:** confirm OpenClaw's license
  permits it at implementation time; otherwise reimplement from its observed
  behaviour, which this plan and the discovery report already capture.
- Their roster also proves device-code adapters for GitHub Copilot and
  MiniMax and PKCE-loopback for OpenRouter — out of scope now, but the
  framework mirrors OpenClaw's shape precisely so any of them is one adapter
  away later.

### 2.1 One framework, pluggable provider adapters

New package **`@nessie/model-subscriptions`** (mirroring how
`@nessie/comms-connect` + per-provider adapters are structured), shared by API
and worker. An adapter is a code-level declaration, one per provider:

```ts
interface SubscriptionProviderAdapter {
  key: SubscriptionProviderKey;            // 'openai-codex' | 'kimi' | 'glm' | 'grok'
  displayName: string;
  authStrategy: 'oauth_device' | 'oauth_loopback' | 'api_key';
  transport: {
    runtimeProvider: ModelProviderName;    // which compiled connector carries it
    baseUrl: string;                       // code constant — never user-supplied
    headers?(credential: DecryptedCredential): Record<string, string>;
  };
  models: SubscriptionModelOption[];       // static list + capability snapshot
  verify(credential): Promise<AccountIdentity>;   // probe at link time
  refresh?(credential): Promise<TokenBundle>;     // OAuth adapters only
  termsNote: string;                       // rendered verbatim in the linking UI
}
```

- **Kimi** → `authStrategy: 'api_key'` (subscription key from the Kimi
  console), transport = existing `kimi` connector at its own default base URL.
- **GLM** → `'api_key'` (coding-plan key), transport = `kimi` connector
  parameterised to Zhipu's Anthropic-compatible endpoint, or
  `openai-compatible` against their OpenAI-shape endpoint — decided at
  implementation time by probing which endpoint the coding-plan key accepts.
- **Grok** → `'oauth_device'`, tied to the consumer subscription
  (SuperGrok Heavy, $300/mo, includes the Grok Bot beta and coding; launch
  reporting also cites SuperGrok / X Premium+ tiers). xAI's flow needs **no
  loopback at all**: OIDC discovery against `https://auth.x.ai`
  (`/.well-known/openid-configuration`) + the RFC 8628 device-code grant,
  shared public client `b1a00492-073a-47ea-816f-4c329264a828`, scopes
  `openid profile email offline_access grok-cli:access api:access`;
  discovered endpoints must pass an `x.ai`/`*.x.ai` host check. Inference
  rides the existing `openai-compatible` connector against
  `https://cli-chat-proxy.grok.com/v1` with an `X-XAI-Token-Auth` header.
  Subscription eligibility is enforced by xAI at auth time; a token response
  without a `refresh_token` is a hard link failure, and xAI's consent screen
  may label the app "Grok Build" because the client is shared (say so in the
  linking UI). (Constants verified against OpenClaw `extensions/xai/`,
  2026-09-02 — §2.5.)
- **OpenAI Codex** → `'oauth_device'` primary, `'oauth_loopback'` optional
  desktop nicety, + a **new `codex-subscription`
  connector** (§2.5). Ships in phase 2.

Base URLs and OAuth endpoints are adapter constants, so there is no
model- or user-supplied egress address; token-endpoint calls still go through
`safeFetch` for uniformity.

### 2.2 Data model — the comms pattern, not provider records

Two new tables, deliberately **not** `InferenceProvider` rows (those are
org-scoped, env-credentialed, and lose base-URL precedence to the deployment
chokepoint — bypassing that chokepoint must be a structural decision, §2.4):

- `ModelSubscription` (`model_subscriptions`): `organizationId`, `userId`
  (composite FK to `organization_members`, the `Agent.ownerUserId`
  discipline), `provider` (enum), `status`
  (`active | needs_reauthorization | disconnected | error`),
  `providerAccountId`, `accountLabel`, `keyVersion`, timestamps. Unique
  `(organizationId, userId, provider, providerAccountId)` — OpenClaw keys
  profiles as `provider:profileName` and supports several accounts per
  provider (work + personal); we replicate that, deriving the account
  identity the way they do (id_token email, else a stable subject claim).
  The dropdown shows the account label only when a person holds more than
  one link for a provider. Because accounts can multiply, the agent's
  selection is an explicit **`Agent.modelSubscriptionId` FK**, not a parse
  of the provider string — two linked OpenAI accounts must be
  distinguishable at run resolution, and ambiguity is refused (the comms
  coordinator's `AMBIGUOUS_ACCOUNT` discipline), never resolved by
  recency. `Agent.provider`/`Agent.model` keep the `subscription/<key>`
  namespacing for display and fail-closed routing.
- **Token values live in the Nessie vault** — the deployment's own Infisical
  at `vault.unlikeotherai.com` (`docs/secret-management-spec.md`,
  `api/src/services/infisical-vault.ts`) — **never in PostgreSQL.** The
  secret-management spec is explicit that new secret-capture flows must not
  add values to Nessie's Postgres database; the encrypted comms/MCP token
  tables are its named legacy-migration concern, so this feature does not
  extend that pattern. The bundle (access token, refresh token, expiry,
  account id — one self-describing JSON value, so the vault alone is
  authoritative) is written to a **dedicated, separately-ACLed Infisical
  project/namespace for model subscriptions** (paths partitioned
  `/<organizationId>/<userId>/…`, server-minted opaque names) — deliberately
  **not** the shared `/nessie/<orgId>/personal/<userId>` partition, because
  that folder also holds the person's ordinary captured secrets and an
  identity scoped to it could read them all (review finding, §6).
- `ModelSubscriptionCredential` is therefore **metadata only**:
  `subscriptionId @unique`, `vaultReference @unique`, advisory `expiresAt`
  (cheap "refresh soon" queries; the vault bundle is the truth), timestamps.
  No ciphertext columns. It is a purpose-specific pointer like
  `McpServerInstance.credentialRef`, deliberately **not** a
  `Secret`/`SecretGrant` row — those are the user-visible secret-management
  surface with grant semantics, and a subscription credential is
  system-managed: it must never appear in the secrets UI, take `use`/`reveal`
  grants, or be mentionable to a model. Values never enter model context,
  responses, logs, or audit metadata — the token goes from the coordinator
  straight into the provider `Authorization` header, exactly like today's
  provider API keys.
- **Why vault-referenced OAuth is safe here** (where OpenClaw refuses it):
  OpenClaw has no central lock, so splitting mutable OAuth state across
  stores would create two refresh owners. Nessie's single refresh owner is
  the server behind the Postgres row lock (§2.5); the vault `replace` and
  the advisory metadata update happen inside that locked section, so the
  vault is a value store behind one serialized writer, not a second
  authority.
- **Worker access is a deliberate, narrow amendment to the vault deployment
  contract.** Today only the API container holds the Infisical
  machine-identity token, and the worker/executor/sandboxes deliberately do
  not. Inference runs in the worker, so the worker gets its **own dedicated
  machine identity scoped to the model-subscriptions vault project only**
  (its own Docker secret in
  `infrastructure/compose/docker-compose.prod.yml`), used solely by the
  subscription credential coordinator — the project separation above is what
  makes "subscription paths only" actually enforceable as an ACL rather than
  a promise. A compromised worker therefore reaches subscription tokens
  (unavoidable: it must dispatch with them) but no other personal secrets.
  The executor and agent sandboxes still receive nothing, and the
  credential-broker boundary the secret spec sketches under "Next phases"
  remains the end-state: the coordinator is written as the single seam so
  moving it behind a broker later is mechanical. `docs/secret-management-spec.md`
  and `docs/deployment.md` are updated in the same change that introduces it.
  In local dev the worker runs embedded in the API process, so a compose'd
  local Infisical (or the API's identity) covers it; a deployment without
  the vault configured cannot link subscriptions — the settings surface says
  so plainly and linking fails loudly, never a silent Postgres fallback.
- OAuth state reuses the `comms_oauth_states` shape (own table
  `model_subscription_oauth_states`, single-use atomic consume, 10-min TTL).

Refresh is serialized, but **not** by holding a Postgres transaction open
across the provider call (the comms coordinator does exactly that today and
the review flagged it): the coordinator takes a short locked **claim** on
the metadata row (bumping a `credentialEpoch`), releases the transaction,
performs the network refresh outside any transaction, and finalizes with a
compare-and-swap on that epoch — vault `replace` first, then metadata. An
indeterminate outcome (response lost after the provider may have consumed
the rotated token) is never retried; it parks the row for recovery or
re-auth. Three more rules from the same review: **every** lifecycle
mutation — relink, disconnect, health sweep, deactivation cleanup — goes
through the same subscription-scoped lock + epoch CAS, never just refresh;
a failure transition (`needs_reauthorization`) is applied **only if the
failing credential epoch is still current**, so a delayed 401 from a
pre-relink token cannot kill a fresh link; and an in-flight run that gets a
401 mid-stream after a concurrent rotation gets exactly one retry that
re-reads the fresh token through the coordinator. (Not the MCP resolver's
lockless refresh — two concurrent runs on one subscription must not race a
one-shot refresh token.)

### 2.3 The dropdown: a "Your subscriptions" group

- `GET /api/agents/models` composes two sources for the acting user: the
  Ledger catalogue (unchanged) and the user's `active` subscriptions' model
  lists. `AgentModelOptionSchema` gains `source: 'ledger' | 'subscription'`
  (default `'ledger'` so existing clients are untouched).
- `ModelCombobox` renders the subscription group under a **"Your
  subscriptions"** header with the provider mark; when the user has none, a
  single affordance row — "Link a personal subscription…" — deep-links to
  `/settings/connections`. (Rule zero: the doorway lives where the question
  arises.)
- **Storage:** `Agent.provider` stores a namespaced key,
  `subscription/<adapterKey>` (e.g. `subscription/openai-codex`);
  `Agent.model` stores the model id. The `/` is illegal in a Ledger
  `serviceId` (`resolveLedgerServiceBaseUrl` throws), so a mis-routed value
  fails loudly rather than dispatching to Ledger — fail-closed by
  construction. No new Agent column.
- **Write-time validation:** `assertAgentModelSelection` becomes a two-armed
  check — Ledger pairs go through `assertLedgerAgentModelSelection`
  unchanged; `subscription/*` pairs require that the **acting user** holds an
  `active` subscription for that adapter and the model is in its list, AND
  that the acting user is (or becomes) the agent's `ownerUserId`. Selecting a
  subscription model on an agent you don't own is refused in words.

### 2.4 Run routing and the ownership gate

`resolveStageProviderConfig` gains one structural branch **before** the
deployment/org chain: if `agent.provider` parses as `subscription/<key>`:

1. Load the subscription for `(channel.organizationId, agent.ownerUserId,
   key)` — the **agent owner's** link, never the poster's. Re-derive the
   owner's live membership (`deactivatedAt: null`) and `status === 'active'`,
   per the standing "the FK proves existence, never liveness" rule.
2. Resolve the credential through the locked coordinator (refresh if near
   expiry), and return `{ baseUrl: adapter.baseUrl, apiKey: accessToken,
   connectorKind, model, providerKey }` — the deployment `NESSIE_MODEL_*`
   chain is intentionally not consulted.
3. Signing needs no change: the effective URL is non-Ledger, so
   `createProviderRequestHeadersResolver` already returns `undefined` and no
   Nessie/UOA identity leaves the deployment.

**This is not a parallel connection to Ledger — it is a second egress lane
that never touches Ledger at all.** A subscription-routed run opens no
Ledger connection, sends no `X-Nessie-Context`/`X-UOA-Delegation`, and
produces no Ledger-side metering or UOA rating; its usage is recorded only
locally (`token_ledger_events`, §2.6). Ledger remains the one chokepoint for
every non-subscription run, byte-identical to today. The rejected
alternative — proxying subscription traffic *through* Ledger — would put
personal credentials on UOA infrastructure and invite commercial rating of
spend that is not the org's; it is out. A run's **generative inference** is
entirely one lane or the other — main turns, delegates, compaction, and
utility calls all follow the run's lane, which is resolved and **pinned at
run admission**: the resolved subscription id, provider account, and
credential epoch are persisted on the `Run`, so a mid-run relink cannot
switch accounts, and a continuation/restart whose binding is no longer valid
fails closed instead of sliding to Ledger. Deliberately **not** on the run's
lane, and always deployment-billed: the engagement decision (made on the
boot-time model client before any run exists), embeddings and memory
operations, avatar generation, and other non-run system inference
(demonstration generalization calls `runInferenceGraph` directly) — §6
requires enumerating every such caller, and §2.6 says this plainly on the
ops surface so a "subscription-only" agent's residual Ledger events read as
designed, not as a bug.

**Who pays is who owns.** Any run of the agent — a shared channel answering a
colleague, a trigger, a delegate — spends the owner's plan, because the agent
is the owner's virtual employee. That is stated plainly on the linking screen
and in the Designer when a subscription model is selected on a
workspace-visible agent. Delegate sub-agents and compaction/utility calls for
that run stay on the same subscription (they are the same run's spend);
utility-model resolution **explicitly returns null** for subscription runs —
not a lookup miss — and `runUtility` is pinned to the run's own resolved
subscription model, because `NESSIE_UTILITY_MODEL` names a Ledger-catalogue
model a subscription backend may not serve.

**Org budgets gate org spend, so they do not gate this lane.** The
`applyBudgetGate` verdict is skipped for subscription-pinned runs: a token
cap set to protect Ledger spend must not block a run that costs the org
nothing (with Ledger copy, no less), and `Budget.mode = degrade` must never
rewrite the run onto the org's Ledger provider — a degrade override is
ignored on this lane (the lane is pinned; there is nothing safe to degrade
to). The per-run backstop envelope (`Agent.runLimits` /
`NESSIE_RUN_BACKSTOP_*`) still applies in full.

**No silent fallback.** If the subscription is missing, revoked,
`needs_reauthorization`, or the owner's membership is deactivated, the run
fails with a classified, remedy-naming stop (the trigger-health discipline:
the transition owns the alert) — never a quiet fallback to Ledger, which
would move spend to the org without consent:

- Interactive run → visible failure notice in-thread with a deep link to
  `/settings/connections` (owner) or "ask <owner> to relink" (others).
- Unattended/trigger run → the existing trigger-health machinery: flip to
  `needs_reauthorization` with a durable `UserAlert` to the **owner** (not
  org owners — it is their credential), exactly once per transition.

Ownership transfer of an agent whose model is `subscription/*` clears
`provider`, `model`, and the subscription pointer in the same transaction —
the new owner never inherits spend on the old owner's plan. Three
implementation facts make this more than one UPDATE: the current update seam
cannot null a model (`model: input.model ?? existing.model`,
`api/src/services/agent-management.ts:139`), so explicit clear semantics are
added; `spawn_subtask` children are separate rows copying the parent's
provider/model outside write-time validation, so transfer/revocation sweeps
must cover `parentAgentId` descendants; and clones and PA `agent_create`
must validate through **one shared route-equivalent validator** in
`@nessie/workspace-admin` (the PA tool currently hard-codes
`assertLedgerAgentModelSelection`), with clones to a different owner
stripping the subscription selection. The **run-time gate is the
authoritative backstop** for any stale row all of that misses: it fails
closed on owner/subscription mismatch, so write-time validation is UX, not
security.

### 2.5 The OAuth adapters: Codex and Grok (phase 2) — our own grant, always

**Prior art: OpenClaw** (sibling repo, verified at origin/main
`64807afd269`, 2026-09-02). It hit exactly the failure this section is
designed against and documents it (`docs/concepts/oauth.md`, "The token
sink"): providers mint a new refresh token on login/refresh and invalidate
the previous one, so two apps sharing one grant randomly log each other out.
Its Codex-CLI credential-import path was **removed** (their changelog
#70390); their rule is that the app runs its **own authorization request**
and its own stored refresh token is canonical.

Nessie adopts the same principle, stated as an invariant:

> **A subscription link is Nessie's own OAuth grant.** Nessie never reads,
> imports, or accepts the vendor CLI's stored credentials
> (`~/.codex/auth.json`, `~/.grok/auth.json`, keychain items). One grant =
> one refresh owner = no rotation conflicts with the app the person already
> uses. The earlier `auth.json` import fallback is dropped from this plan
> for exactly that reason.

**Primary flow for both: RFC 8628 device code, run entirely server-side.**
Both providers support it (constants verified against OpenClaw's
`extensions/openai/openai-chatgpt-device-code.ts` and
`extensions/xai/xai-oauth.ts`):

1. `POST /api/model-subscriptions/:provider/start` — the server asks the
   provider's device-authorization endpoint for a code and returns
   `{ userCode, verificationUrl, expiresAt }`; PKCE material and the pending
   state live in the one-shot pg state row.
2. The settings page shows the code and link ("enter **XXXX-XXXX** at
   …"); the person completes consent in any browser on any device — no
   loopback listener, no desktop dependency, works for web-only users.
3. The server polls the token endpoint at the provider's stated interval
   (honouring `slow_down`), performs the exchange, verifies the id_token,
   seals the bundle. Tokens never touch the browser.

This removes the Tauri loopback command from the critical path entirely. A
loopback browser flow (Codex's fixed `localhost:1455` redirect) can be added
later as a desktop nicety; it is no longer load-bearing.

**Device-flow hardening (both reviewers, §6):**

- `start` and the poll are **per-user rate-limited** (the
  `RATE_LIMIT_BUCKETS` machinery), and polling is one server-side lease per
  state row with `nextPollAt` honouring the provider's `interval` and
  `slow_down` — several tabs or replicas must not each hammer the shared
  public client.
- The classic device-flow confused deputy is addressed head-on: a
  **relink** binds the expected `providerAccountId` and refuses a different
  account at completion (the comms `expectedAccountId` discipline), and a
  **first link** shows the verified provider identity (email/subject) for
  explicit confirmation *before* the subscription activates — so a phished
  code session cannot silently attach an attacker's account to a victim's
  workspace, and the screen says "only enter codes you requested here."
- "Verify the id_token" means a spec, not a vibe: exact issuer, audience =
  the client id, `exp`, a present stable subject, nonce where the provider
  supports it, and **granted scopes read from the token response, failing
  closed on anything missing** — the `grantedScopes` lesson from the Google
  capability catalog applies verbatim.
- **403 is not "revoked".** Only adapter-defined authentication failure
  codes transition a link to `needs_reauthorization`; entitlement, scope,
  policy, quota, and content refusals classify separately (the Google
  `insufficientPermissions` lesson), so a healthy grant is never disabled
  with the wrong remedy.

Adapter constants, to be re-pinned from the reference clients at
implementation time:

- **Codex:** `auth.openai.com` authorize/token/deviceauth endpoints, the
  public Codex client `app_EMoamEEZ73f0CkXaXp7hrann`, scopes
  `openid profile email offline_access`, the `chatgpt_account_id` claim, and
  the backend `https://chatgpt.com/backend-api/codex/responses` contract
  (Responses API shape, `store: false`, streaming, `chatgpt-account-id` +
  `OpenAI-Beta` headers, `gpt-5-codex` family). OpenAI's flow accepts an
  `originator` parameter — Nessie sends `originator=nessie` (OpenClaw's
  precedent). Honest framing from the review: this is still the vendor's
  shared public OAuth client, not a separately registered Nessie client —
  `originator` identifies the integration, it does not change the client.
  **Each OAuth adapter ships only once its vendor-sanctioned basis is
  verified and recorded in this doc** (OpenAI's published policy on
  subscription OAuth in external tools; xAI's equivalent), and a
  provider-approved Nessie client registration is preferred wherever a
  vendor offers one.
- **Grok:** §2.1 — OIDC discovery on `auth.x.ai`, shared public client,
  device-code grant, `cli-chat-proxy.grok.com/v1` backend on the
  `openai-compatible` connector.

**Refresh discipline (hardening §2.2's coordinator with OpenClaw's field
lessons):**

- One refresh owner per token family: the Nessie server, under the
  `FOR UPDATE` row lock. Inside the lock, **re-read before spending** — a
  caller that was queued behind a peer's successful refresh adopts the fresh
  token instead of burning the rotated refresh token.
- **Never retry a refresh grant on a transport failure.** A response lost
  after the provider consumed the token has already rotated it; a resend
  burns the family (xAI rotates aggressively — OpenClaw retries only
  Cloudflare-challenge responses, and only for xAI).
- Refresh proactively at a 5-minute expiry margin, not on 401.
- Classify `refresh_token_reused` / `invalid_grant` / `revoked` as distinct
  reasons: reuse means a race or a second client on the same grant (re-read
  once, then `needs_reauthorization`); the others go straight to
  `needs_reauthorization`. A token response missing `refresh_token` fails
  the link immediately.

Connector work: Codex needs a new `codex-subscription` runtime provider
speaking the Responses API (streaming deltas mapped onto the existing
`output_text.delta` / `tool_call.delta` event shape so the loop, thinking
recorder, and document streaming see nothing new); Grok rides the existing
`openai-compatible` connector with its header additions. Vision per each
backend's actual support; `structuredOutputMode` and tool calling are native
for both.

### 2.6 Metering, budgets, ops

- Every run invocation still writes `TokenLedgerEvent` rows with real token
  counts — but the exclusion from org cost is **structural, not an absent
  seed row**. The review showed the naive version lies twice: connector
  invocations record the *runtime* provider (`'openai-compatible'`), not the
  agent's `subscription/<key>`, and an owner-created wildcard
  `ModelPricingProfile` would happily price the events. So the event carries
  an explicit source (`billingSource = 'personal_subscription'` +
  `modelSubscriptionId`, attribution to the **subscription owner**), pricing
  resolution skips those events by that field, and org budget evaluation
  excludes them entirely (matching §2.4's gate skip). Token counts remain
  for the per-run backstop and ops visibility.
- Failure classification per §2.5: only adapter-defined authentication codes
  flip a link to `needs_reauthorization` (version-guarded, §2.2). Provider
  quota/rate-limit refusals (subscription plans have rolling windows) → a
  classified budget-stop-style notice naming the plan's limit, never the
  Ledger `CREDITS_EXHAUSTED` copy — the person must not be told to buy org
  credits when their personal window is exhausted. The classification seam
  lives in the adapter (it knows its provider's error shapes), surfaced
  through the existing budget-stop/cancel-stop notice machinery.
- `ModelSubscription` carries typed `healthReason`/`healthDetail`/
  `healthRevision` (the trigger-health discipline), and the
  exactly-once-per-transition alert goes to the **subscription owner** with
  a deep link to `/settings/connections` — a surface the owner can actually
  reach, unlike the owner-gated Triggers page. Every lifecycle transition
  (link, relink, refresh failure, disconnect, deactivation cleanup) writes a
  metadata-only audit event — never tokens, vault references, or raw
  provider responses.
- Runs are stamped with their lane (`Run` binding, §2.4) and the run
  inspector / `run.timing` surfaces say "personal subscription (<owner>)",
  so "whose plan paid for this reply" has an answer where the question
  arises (Rule zero check 3).
- `/ops/usage` (owner-only) gains a per-provider split so subscription-routed
  tokens are visible as such; `/tokens` (UOA customer billing) is untouched —
  personal subscriptions are not org commercial state and never render there.

### 2.7 Surfaces (Rule zero check)

- **Home:** `/settings/connections` → new "Model subscriptions" section using
  the existing `ConnectionCard` shape: provider mark, account label, status
  chip (`Needs reauthorization` reuses the comms tone map), Relink,
  Disconnect. Disconnect deletes the credential row and flips status —
  mirroring the comms delete; agents pointing at it fail per §2.4 and their
  Designer shows the remedy.
- **Doorways:** the Designer dropdown group + its "Link a personal
  subscription…" row; failure notices deep-linking to settings; the trigger
  health page already names `needs_reauthorization` remedies.
- **Every element names a decision:** the settings card answers "is my plan
  linked and healthy"; the dropdown group answers "can this agent run on my
  plan"; nothing else ships.
- **Reuse:** `ConnectionCard`, the comms coordinator pattern, the MCP
  constant-callback-page discipline, the existing connectors — no new
  look-alikes.

## 3. Terms-of-service honesty

Each adapter carries a `termsNote` rendered verbatim at link time. For
Codex: OpenClaw's docs state OpenAI explicitly supports subscription OAuth
in external tools (re-verify against OpenAI's own published policy at
implementation time); the note still says this spends the person's own
account, is their own choice, and can hit their plan's rate windows. Similar
notes for Kimi/GLM coding-plan keys and the Grok subscription login. The
feature is per-user opt-in,
default absent, and never provisioned by an admin on someone's behalf.
Anthropic: excluded outright (§ top).

## 4. Phasing

1. **Phase 1 — framework + API-key adapters (Kimi, GLM).** Schema +
   `@nessie/model-subscriptions` + coordinator, settings section, dropdown
   group + the one shared validator, `resolveStageProviderConfig` branch +
   run-admission pinning + ownership gate + failure classification, metering
   split. GLM's endpoint/protocol is **pinned and documented before the
   phase starts** (not probed mid-build); only then does "no new connector
   code" hold — `kimi` and `openai-compatible` carry both transports.
2. **Phase 2 — OAuth device-code: Codex + Grok.** Server-side device flow
   (start/poll lease/complete/refresh with the §2.2/§2.5 discipline),
   settings UI for the code+link+confirm-identity steps, the
   `codex-subscription` Responses-API connector; Grok on `openai-compatible`.
   Entirely server-side — no desktop work in the critical path. Gated on the
   vendor-sanction verification in §2.5.
3. **Phase 3 — polish.** Health probe sweep (mark dead links before a run
   trips on them), per-subscription concurrency lease + owner-visible
   limiter (several agents can otherwise drain one plan's window
   concurrently — run slots are per `(agent, thread)` only), quota-window
   classification per provider, owner alert copy, `/ops/usage` split
   refinement, optional desktop loopback browser flow for Codex.

**Testing (required, not phase 3):** mock-llm grows a Responses-API surface
(`packages/mock-llm` speaks only chat/completions + embeddings today) so the
Codex connector gets full-pipeline smoke coverage; DB suites cover the
refresh claim/CAS races, relink-vs-stale-401, disconnect-vs-refresh,
transfer/deactivation sweeps, continuation binding failure, budget-gate
skip, and secret non-disclosure (no token in any response, event, or log).
Prove the gates fail without the fix, per standing practice.

**Rollout ordering:** schema first, then workers that understand
`subscription/*` and the run binding, then the API writes behind a
deployment capability flag, UI last — an API replica must never persist a
subscription selection an old worker would misroute. Upgrade-path fixture
covers the new tables; vault cleanup (disconnect, deactivation, org delete)
ships with the schema as a durable tombstone/outbox with idempotent vault
deletion, so no orphaned refresh tokens outlive their Postgres pointers, and
the health sweep refuses to refresh a deactivated owner's credential.

## 5. Open decisions (for Ondrej)

1. **Shared-channel spend — now with a disclosure dimension.** Plan says:
   owner pays for every run of their agent, stated clearly at selection
   time. Alternative: v1 restricts subscription models to
   `visibility: private` agents + the owner's PA. The review sharpened the
   stakes: this is not only "whose money" but "whose processor" — a
   workspace agent on a personal subscription sends workspace/project/KB
   content in prompts to the *person's consumer account* at the provider,
   which the disclosure sink (who may read the reply) does not govern. If
   workspace use ships, it comes with an org-level policy switch (owner
   setting: allow personal subscriptions on workspace-visible agents, or
   private-only), so the organisation decides where its data may be
   processed. This must be resolved before implementation starts.

Resolved:

- *2026-09-02 — Grok included* as a first-class subscription adapter:
  SuperGrok Heavy's $300/mo plan covers Grok Bot + coding, and xAI's
  device-code OAuth is a sanctioned subscription-linked path.
- *2026-09-02 — no credential import.* The `auth.json` paste fallback is
  dropped; every link is Nessie's own grant (§2.5), so linking never fights
  the vendor CLI's session. Device code makes this work for web-only users
  anyway.

## 6. Adversarial review record (Kimix + Codex Sol, 2026-09-02)

Both reviewers ran independently against the repo with the same brief:
break this plan. Findings were adjudicated against the code (not averaged);
everything accepted above is folded into §§2.2–2.6, §4, §5. This section
records what remains and what was rejected, so the next reader doesn't
re-litigate it.

**Accepted, folded in above:** org-budget gate skip + degrade never rewrites
the lane (both reviewers); run-admission pinning of subscription/account/
credential epoch on the `Run`, continuation fails closed (Sol); the
"one lane" claim scoped to generative inference, with engagement decisions,
embeddings/memory, avatars, and demonstration-generalize named as
deployment-billed (both); explicit-null utility resolution (Kimix);
dedicated vault project + worker identity scoped to it, broker as end-state
(both — Sol showed the shared personal folder made narrow scoping
unenforceable); `Agent.modelSubscriptionId` FK + ambiguity refusal (Sol);
claim/CAS refresh outside transactions, one lifecycle lock, epoch-guarded
failure transitions, one mid-stream 401 retry (both); vault
tombstone/outbox cleanup on disconnect/deactivation/org-delete, sweep
refuses deactivated owners (both); device-flow rate limits, poll lease,
expectedAccountId on relink, identity confirmation before first activation,
id_token + granted-scopes fail-closed spec, 403 classification (both);
structural `billingSource` on ledger events with owner attribution and
pricing bypass (Sol — invocations record the runtime provider, and wildcard
pricing profiles would otherwise price these); health
reason/detail/revision + owner-directed alerts + metadata-only audit events
(Sol); transfer clears provider+model+pointer with real null semantics,
descendant sweep, one shared validator covering PA create and clones,
run-time gate as authoritative backstop (both); run-level lane provenance
in the inspector (Kimix); mock-llm Responses surface + race-test suite +
rollout ordering + GLM pinned pre-phase-1 (both); shared-channel decision
now carries the whose-processor dimension and an org policy switch (Sol).

**Implementation-time obligations (tracked here, no doc section yet):**

- **Transport hardening:** connectors reach the subscription backend
  through a host-pinned, no-redirect fetch whose allowed origin comes from
  the adapter constant, asserted at connector construction; the connector
  receives an access-token-only auth object, never the decrypted bundle
  (the refresh token has no business in the dispatch path). Today's
  connectors use plain redirect-following `fetch` — the env-precedence
  chokepoint this lane bypasses was the only guard.
- **Enumerate every consumer of `Agent.provider`** (utility-model SQL
  lookup, `/ops/usage` groupings, admin filters, avatar generation) and
  give each an explicit `subscription/*` branch; the single
  `resolveLedgerServiceBaseUrl` throw is one fail-closed site, not an
  audit.
- **Same account, two orgs:** two Nessie grants for one vendor account
  (person in two organisations) may mutually invalidate under the shared
  client — verify each provider's concurrent-grant behaviour and record
  the answer here before GA.
- **Catalogue isolation:** `GET /api/agents/models` must render
  subscription options even when the Ledger catalogue errors, and creating
  a subscription-backed agent must not implicitly charge Ledger for avatar
  generation without saying so.
- **AGENTS.md amendment:** shipping this lane amends the
  "`NESSIE_MODEL_BASE_URL` is the deployment-wide inference chokepoint"
  statement in `AGENTS.md`/`CLAUDE.md` in the same change, per the
  docs-sync rule.

**Rejected, with reasons:**

- *"Live UOA membership must be re-resolved from the UOA API on every
  subscription use"* (Sol). Overreach: the standing discipline for every
  gate in the tree (`buildVisibleAgentWhere`, comms sync, trigger sweeps)
  is the local live-membership row (`deactivatedAt: null`), reconciled from
  UOA; this gate follows the same predicate. Making one gate call UOA
  per-run would be a new pattern with its own availability failure mode.
- *"PKCE/device state in Postgres violates the secret-management rule"*
  (Sol). The rule bars durable secret *values*; one-shot flow state with a
  10-minute TTL is the standing `comms_oauth_states`/`mcp_oauth_states`
  pattern. The real defect in that finding — unserialized polling — is
  accepted above as the poll lease.
- *"Resolve shared-channel spend by fiat now"* (Sol). It is §5's explicit
  owner decision; the plan now blocks implementation on it rather than
  deciding it in a review pass.

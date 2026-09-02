# Personal model subscriptions — run your own agents on your own plan

**Status: proposed (plan only — nothing built).**

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
- **What deliberately differs:** storage (Nessie's encrypted per-user
  Postgres tables instead of per-agent SQLite; the server is the one refresh
  owner), tenancy (rows scoped `(organizationId, userId)`), and surface (the
  admin settings page instead of a CLI). Behaviour at the provider boundary
  stays byte-alike.
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
  one link for a provider.
- `ModelSubscriptionCredential`: `subscriptionId @unique`,
  `accessTokenCiphertext`, `refreshTokenCiphertext?`, `expiresAt?`,
  `keyVersion` — sealed with the shared `secret-crypto` primitives.
  For API-key adapters the key lives in `accessTokenCiphertext` and never
  expires; credential material is NEVER part of any response schema.
- OAuth state reuses the `comms_oauth_states` shape (own table
  `model_subscription_oauth_states`, single-use atomic consume, 10-min TTL).

Refresh follows the comms coordinator exactly: `FOR UPDATE` row lock,
re-read, refresh via the adapter, re-seal in the same transaction; a
provider-rejected credential flips `status = 'needs_reauthorization'`
atomically. (Not the MCP resolver's lockless refresh — two concurrent runs on
one subscription must not race a one-shot refresh token.)

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
spend that is not the org's; it is out. A run is entirely one lane or the
other, decided once at provider resolution: its delegates, compaction, and
utility calls follow the same lane, so no single run mixes Ledger-signed and
personal traffic.

**Who pays is who owns.** Any run of the agent — a shared channel answering a
colleague, a trigger, a delegate — spends the owner's plan, because the agent
is the owner's virtual employee. That is stated plainly on the linking screen
and in the Designer when a subscription model is selected on a
workspace-visible agent. Delegate sub-agents and compaction/utility calls for
that run stay on the same subscription (they are the same run's spend);
`NESSIE_UTILITY_MODEL` resolution is skipped for subscription-routed runs.

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

Ownership transfer of an agent whose model is `subscription/*` clears the
model back to null (deployment default) in the same transaction — the new
owner never inherits spend on the old owner's plan.

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

Adapter constants, to be re-pinned from the reference clients at
implementation time:

- **Codex:** `auth.openai.com` authorize/token/deviceauth endpoints, the
  public Codex client `app_EMoamEEZ73f0CkXaXp7hrann`, scopes
  `openid profile email offline_access`, the `chatgpt_account_id` claim, and
  the backend `https://chatgpt.com/backend-api/codex/responses` contract
  (Responses API shape, `store: false`, streaming, `chatgpt-account-id` +
  `OpenAI-Beta` headers, `gpt-5-codex` family). OpenAI's flow accepts an
  `originator` parameter — Nessie sends `originator=nessie`, identifying
  itself honestly as a distinct client of the shared public app rather than
  impersonating the CLI (OpenClaw's precedent; OpenAI documents subscription
  OAuth as supported in external tools).
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

- Every invocation still writes `TokenLedgerEvent` rows (`provider =
  'subscription/<key>'`, real token counts). No `ModelPricingProfile` rows are
  seeded for subscription providers, so `estimatedCostAmount` stays `null`:
  org **cost** budgets deliberately see zero (the org isn't paying), while
  **token** budgets and the per-run backstop envelope meter unchanged.
- Provider 401/403 → `needs_reauthorization` transition (§2.4). Provider
  quota/rate-limit refusals (subscription plans have rolling windows) →
  a classified budget-stop-style notice naming the plan's limit, never the
  Ledger `CREDITS_EXHAUSTED` copy — the person must not be told to buy org
  credits when their personal window is exhausted.
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
   group + two-armed validation, `resolveStageProviderConfig` branch +
   ownership gate + failure classification, metering split. No new connector
   code — `kimi` and `openai-compatible` carry both transports.
2. **Phase 2 — OAuth device-code: Codex + Grok.** Server-side device flow
   (start/poll/complete/refresh with the §2.5 refresh discipline), settings
   UI for the code+link step, the `codex-subscription` Responses-API
   connector; Grok on `openai-compatible`. Entirely server-side — no desktop
   work in the critical path.
3. **Phase 3 — polish.** Health probe sweep (mark dead links before a run
   trips on them), quota-window classification per provider, owner alert
   copy, `/ops/usage` split refinement, optional desktop loopback browser
   flow for Codex as a convenience.

## 5. Open decisions (for Ondrej)

1. **Shared-channel spend.** Plan says: owner pays for every run of their
   agent, stated clearly at selection time. Alternative: v1 restricts
   subscription models to `visibility: private` agents + the owner's PA.

Resolved:

- *2026-09-02 — Grok included* as a first-class subscription adapter:
  SuperGrok Heavy's $300/mo plan covers Grok Bot + coding, and xAI's
  device-code OAuth is a sanctioned subscription-linked path.
- *2026-09-02 — no credential import.* The `auth.json` paste fallback is
  dropped; every link is Nessie's own grant (§2.5), so linking never fights
  the vendor CLI's session. Device code makes this work for web-only users
  anyway.

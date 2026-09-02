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

### 2.1 One framework, pluggable provider adapters

New package **`@nessie/model-subscriptions`** (mirroring how
`@nessie/comms-connect` + per-provider adapters are structured), shared by API
and worker. An adapter is a code-level declaration, one per provider:

```ts
interface SubscriptionProviderAdapter {
  key: SubscriptionProviderKey;            // 'openai-codex' | 'kimi' | 'glm' | 'grok'
  displayName: string;
  authStrategy: 'oauth_loopback' | 'api_key';
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
- **Grok** → `'oauth_loopback'`, tied to the consumer subscription
  (SuperGrok Heavy, $300/mo, includes the Grok Bot beta and coding; launch
  reporting also cites SuperGrok / X Premium+ tiers). xAI's open-source
  terminal agent **Grok Build** (`xai-org/grok-build`) is the reference
  client: standard OIDC discovery
  (`{issuer}/.well-known/openid-configuration`), authorization-code + PKCE,
  scopes `openid profile email offline_access api:access`, and — unlike
  Codex — a **port-agnostic loopback redirect** (`http://127.0.0.1/callback`,
  RFC 8252), so the desktop capture can bind an ephemeral port. Tokens live in
  `~/.grok/auth.json` with silent refresh; subscription eligibility is
  enforced at auth time, so an ineligible account simply fails the link. The
  issuer, client_id, backend endpoint and protocol shape (expected
  OpenAI-compatible; models `grok-4` family + `grok-code-fast`) are pinned at
  implementation time from the Grok Build source, like Codex (§2.5). Same
  `auth.json` import fallback applies.
- **OpenAI Codex** → `'oauth_loopback'` + a **new `codex-subscription`
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
  `(organizationId, userId, provider)` — one link per provider per member.
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

### 2.5 The OAuth-loopback adapters: Codex and Grok (phase 2)

OpenAI's "Sign in with ChatGPT" is authorization-code + PKCE against
`auth.openai.com` with a client registered for **one fixed redirect:
`http://localhost:1455/auth/callback`**. So the browser leg must terminate on
the user's own machine. All endpoint/client details below are to be pinned at
implementation time from the current open-source Codex CLI, not hardcoded
from memory: authorize + token endpoints on `auth.openai.com`, the Codex CLI
`client_id`, scopes (`openid profile email offline_access`), the
`chatgpt_account_id` claim in the id_token, and the backend
`https://chatgpt.com/backend-api/codex/responses` contract (Responses API
shape, `store: false`, streaming, `chatgpt-account-id` + `OpenAI-Beta`
headers, and the allowed model list — `gpt-5-codex` family).

**Grok** shares the whole flow with better manners: the Grok Build reference
client uses ordinary OIDC discovery + PKCE with a **port-agnostic** loopback
(`http://127.0.0.1/callback`), so its capture binds an ephemeral port instead
of fighting over a fixed one, and eligibility (SuperGrok Heavy / eligible
tiers) is enforced by the provider at auth time. Its issuer, client_id, and
backend contract are pinned from `xai-org/grok-build` the same way Codex's
are pinned from the Codex CLI.

Two linking paths, desktop first — one generic capture, parameterised per
adapter (never a per-provider fork):

1. **Desktop loopback (primary).** A new Tauri command
   (`subscription_auth_capture`) binds the adapter-declared loopback —
   `127.0.0.1:1455` for Codex, an ephemeral `127.0.0.1` port for Grok — for
   the duration of the flow, guarded by the same
   `assert_approved_companion_caller` origin check as the executor commands.
   Flow: admin calls `POST /api/model-subscriptions/:provider/start` → server
   mints PKCE + one-shot state (verifier stays server-side) and returns the
   authorize URL → shell opens the system browser (`tauri-plugin-opener`) and
   starts the listener → the listener answers the redirect with a constant
   "return to Nessie" page (the MCP callback-page discipline: constant HTML,
   no redirect) and hands `code`+`state` to the admin → admin posts them to
   `…/complete` → the **server** performs the token exchange, verifies the
   id_token, seals the bundle. Tokens are never parked in the browser.
2. **Import fallback (web-only users).** The person runs the provider's own
   login (`codex login` → `~/.codex/auth.json`; Grok Build → `~/.grok/auth.json`)
   on their Mac and pastes the file's contents into a one-time form; the
   server validates shape + probes, then seals it. Blunt but universal, and
   honest about what it is.

Refresh: `grant_type=refresh_token` at the adapter's token endpoint, through
the locked coordinator. Connector work: Codex needs a new
`codex-subscription` runtime provider speaking the Responses API (streaming
deltas mapped onto the existing `output_text.delta` / `tool_call.delta` event
shape so the loop, thinking recorder, and document streaming see nothing
new); Grok's backend is expected to be OpenAI-compatible and would ride the
existing connector with bearer-token headers — confirmed against Grok Build's
source before building. Vision per each backend's actual support;
`structuredOutputMode` and tool calling are native for both.

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

Each adapter carries a `termsNote` rendered verbatim at link time. For Codex:
subscription auth is intended by OpenAI for Codex clients; using it from
Nessie is the person's own choice against their own account, may violate
OpenAI's terms, and can get the account rate-limited or actioned. Similar
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
2. **Phase 2 — OAuth loopback: Codex + Grok.** Server OAuth
   start/complete/refresh, the generic desktop loopback command + admin flow,
   `auth.json` import fallback for both; the `codex-subscription`
   Responses-API connector; Grok pinned from `xai-org/grok-build` (expected
   to ride `openai-compatible`). Grok's ephemeral-port loopback is the
   simpler of the two — build the capture against it first, then add Codex's
   fixed-port case.
3. **Phase 3 — polish.** Health probe sweep (mark dead links before a run
   trips on them), quota-window classification per provider, owner alert
   copy, `/ops/usage` split refinement.

## 5. Open decisions (for Ondrej)

1. **Shared-channel spend.** Plan says: owner pays for every run of their
   agent, stated clearly at selection time. Alternative: v1 restricts
   subscription models to `visibility: private` agents + the owner's PA.
2. **Import fallback scope.** Ship the `auth.json` paste path at all, or
   desktop-only linking for Codex/Grok?

*(Resolved 2026-09-02: Grok is included as a first-class subscription
adapter — SuperGrok Heavy's $300/mo plan covers Grok Bot + coding, and Grok
Build proves a subscription-linked OAuth path exists.)*

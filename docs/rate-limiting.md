# Rate Limiting & Brute-Force Protection

> Status: implemented (issue #211; consolidated in the 2026-09-05 API
> architecture review, FO3-3 / FO3-6 / FO3-7 / FO4-1).

For the auth-specific rules — which routes are public, how the global hook
decides, what a self-guarding handler adds — see
[deployment-modes-and-auth-spec/authentication.md](deployment-modes-and-auth-spec/authentication.md)
→ "### Rate limiting". This file is the mechanism and the full bucket table.

## 1) One limiter

There is exactly one rate limiter in the API: the Postgres-backed fixed-window
counter store in `api/src/services/rate-limit.ts` (`RateLimiter`), constructed
once in `createServerContext` and threaded through `RouteDeps` and the MCP
registrar context.

There used to be two. A hard-coded in-process `Map` in `api/src/lib/rate-limit.ts`
covered four routes with its own thresholds, its own per-replica store and its
own IP canonicalisation, while this limiter covered the auth family — and both
governed `POST /api/auth/session`. The in-process one is gone; its four routes
are buckets in the table below (`threadMessageIp`, `agentWriteIp`,
`mailboxDiscoverIp`, and login, which already had one).

- **Storage**: `rate_limit_buckets` (migration
  `20260724120000_auth_rate_limit_buckets`) — one row per
  `(bucket, key_hash, window_start)` with an atomic upsert-increment, safe
  across replicas and restarts. There is no Redis in this stack; Postgres is
  the only shared store and the endpoints in question already touch it per
  request. Windows are fixed rather than sliding so each identity costs one
  row per live window; ~2% of hits sweep rows from expired windows **within
  their own bucket** (buckets run on different windows, so a short-window
  sweep must never touch a longer bucket's live rows), keeping the table
  bounded by active keys with no background job.
- **Key hashing**: store keys are `sha256(bucket:identity)` — raw IPs and user
  ids are never persisted in the counters table. The bucket name lives only in
  the store key, the audit `resourceId` and the ops-health breakdown, never in
  the rule. Rules are plain `{max, windowMs}` thresholds so they load verbatim
  from config.
- **One pairing table**: `RATE_LIMIT_BUCKETS` and `rateLimitFor` in
  `api/src/routes/auth-rate-limit.ts` are the single place a bucket name is
  paired with its `config.api.rateLimit.<name>` rule. Every guard resolves its
  pair through `rateLimitFor(config, name)` (or `rateLimitForRules`, for the
  one guard handed `config.api.rateLimit` rather than the whole config), so a
  bucket without a matching rule is a compile error rather than a call site
  quietly borrowing an unrelated rule.
- **Client IP**: always Fastify's resolved `request.ip`, which honours
  `X-Forwarded-For` only up to `NESSIE_API_TRUSTED_PROXY_HOPS` hops
  (`createFastifyTrustProxyConfig`, wired in `api/src/index.ts`). Forwarded
  headers are never trusted otherwise. IPv6 client addresses are bucketed by
  their `/64` prefix — the smallest routed allocation — so an attacker holding
  a routed `/64` cannot rotate addresses for fresh counters; IPv4 is bucketed
  per full address.
- **Per-IP AND per-account**: login, refresh, step-up, MCP secret writes and
  subscription device codes maintain both counters on every hit; the request is
  rejected when either trips, so one IP spraying many accounts hits the IP cap
  while one account attacked from many IPs hits the account cap. The login
  account identity is the email normalized (`trim().toLowerCase()`) exactly
  like the account lookup in `loadSessionUserByEmail`, so case and whitespace
  variants of one address share a single counter.
- **429 + Retry-After**: rejected requests get `RATE_LIMITED` 429 with a
  `retry-after` header in seconds.
- **Audit**: a lockout emits exactly one `auth.rate_limit.lockout` audit event
  (`outcome: denied`) per bucket per window — on the transition, i.e. the hit
  that pushes the bucket's counter to `max + 1`. Requests rejected while the
  bucket is already locked out emit nothing: unauthenticated events serialize
  on the zero-org audit advisory lock, so per-request emission would make a
  flood of rejections costlier than acceptances and drown the audit table.
  Authenticated routes emit through the standard `emitAuditEvent` chokepoint
  under the caller's org hash chain; unauthenticated routes (pre-login,
  refresh, OAuth callback) have no caller org, so the event is written under
  the synthetic zero-UUID system org with the true identity only as a hash in
  metadata.
- **Ops visibility**: cumulative `checks` / `limited` / `storeErrors` /
  `limitedByBucket` counters are exposed on `GET /api/ops/health`
  (`rateLimit`). They are per-process since boot.
- **Fail-open**: any store error (DB outage, missing migration) logs a loud
  `[rate-limit] FAIL-OPEN` line, increments `storeErrors`, and allows the
  request — availability beats lockout.

## 2) Where the check runs

`registerGlobalAuthHook` (`api/src/lib/global-auth-hook.ts`) builds the API-wide
check from the shared limiter and config, and applies it in an **`onRequest`**
hook — before the JSON body parser buffers the payload and before multipart
accepts up to `storage.maxUploadBytes`. The cheapest rejection a server can make
must not be its most expensive one. Actor resolution stays at `preHandler`.

Which bucket governs a request is decided by `resolveGlobalRateLimitBucket`:

1. `GET /api/auth/me` → `authMeIp`.
2. A `POST` whose route pattern is named in the table → that bucket.
3. A `POST` to one of the executor-daemon session routes →
   `executorDaemonSessionIp`.
4. Any write under `/api/agents…` → `agentWriteIp`.
5. Otherwise, **any route declaring `config.public`** → `publicRouteIp`.
6. Otherwise, no limit.

Point 5 is the important one: coverage of a public route is a property of being
public, not of somebody remembering to add a guard. A handler that also guards
itself (login, refresh, bootstrap, SSO authorize, MCP OAuth, subscription
device codes) keeps its own tighter bucket **in addition to** that floor — the
floor is never a replacement for it.

Exempt: `/api/health`, `/api/health/ready`, and the realtime SSE/WebSocket
streaming endpoints carry no limits.

## 3) Buckets

Every rule is `{max, windowMs}` under `api.rateLimit` in `nessie.config.json`.
Each is independently overridable with the `NESSIE_RATE_LIMIT_<NAME>_MAX` and
`NESSIE_RATE_LIMIT_<NAME>_WINDOW_MS` environment variables listed below (e.g.
`NESSIE_RATE_LIMIT_LOGIN_ACCOUNT_MAX=3`) — see also the configuration reference
in [deployment/configuration.md](deployment/configuration.md).

Applied by the handler:

| Bucket | Surface | Env prefix | Default |
|---|---|---|---|
| `loginIp` | `POST /api/auth/session` | `NESSIE_RATE_LIMIT_LOGIN_IP_` | 10 / 10 min |
| `loginAccount` | same, per email | `NESSIE_RATE_LIMIT_LOGIN_ACCOUNT_` | 5 / 10 min |
| `refreshIp` | `POST /api/auth/refresh`, UOA team exchange | `NESSIE_RATE_LIMIT_REFRESH_IP_` | 30 / 10 min |
| `refreshAccount` | same, per presented token's user | `NESSIE_RATE_LIMIT_REFRESH_ACCOUNT_` | 20 / 10 min |
| `bootstrapIp` | `POST /api/auth/bootstrap` | `NESSIE_RATE_LIMIT_BOOTSTRAP_IP_` | 10 / 10 min |
| `ssoAuthorizeIp` | `GET /api/auth/providers/:id/authorize` | `NESSIE_RATE_LIMIT_SSO_AUTHORIZE_IP_` | 20 / 10 min |
| `mcpOauthIp` | MCP OAuth start + callback, App connect | `NESSIE_RATE_LIMIT_MCP_OAUTH_IP_` | 20 / 10 min |
| `mcpSecretWriteIp` | `PUT`/`DELETE /api/mcp/instances/:id/credentials…` | `NESSIE_RATE_LIMIT_MCP_SECRET_WRITE_IP_` | 20 / 10 min |
| `mcpSecretWriteAccount` | same, per actor | `NESSIE_RATE_LIMIT_MCP_SECRET_WRITE_ACCOUNT_` | 10 / 10 min |
| `stepUpIp` | current-password re-proof (`POST /api/auth/password`, executor access changes and workspace promotions) | `NESSIE_RATE_LIMIT_STEP_UP_IP_` | 10 / 10 min |
| `stepUpAccount` | same, per actor | `NESSIE_RATE_LIMIT_STEP_UP_ACCOUNT_` | 5 / 10 min |
| `subscriptionDeviceIp` | personal model-subscription device-code start/poll/confirm/cancel | *(config file only — no env var yet)* | 240 / 10 min |
| `subscriptionDeviceAccount` | same, per actor | *(config file only — no env var yet)* | 120 / 10 min |

Applied by the global hook:

| Bucket | Surface | Env prefix | Default |
|---|---|---|---|
| `authMeIp` | `GET /api/auth/me` | `NESSIE_RATE_LIMIT_AUTH_ME_IP_` | 600 / min |
| `threadMessageIp` | `POST /api/threads/:threadId/messages` | `NESSIE_RATE_LIMIT_THREAD_MESSAGE_IP_` | 60 / min |
| `mailboxDiscoverIp` | `POST /api/mailbox-connections/discover` | `NESSIE_RATE_LIMIT_MAILBOX_DISCOVER_IP_` | 30 / min |
| `agentWriteIp` | any `POST`/`PUT`/`PATCH`/`DELETE` under `/api/agents` | `NESSIE_RATE_LIMIT_AGENT_WRITE_IP_` | 60 / min |
| `triggerWebhookIp` | `POST /api/triggers/webhook`, `POST /api/triggers/:triggerId/webhook` | `NESSIE_RATE_LIMIT_TRIGGER_WEBHOOK_IP_` | 120 / min |
| `commsWebhookIp` | `POST /api/comms/webhooks/slack`, `…/google` | `NESSIE_RATE_LIMIT_COMMS_WEBHOOK_IP_` | 600 / min |
| `boardSourceWebhookIp` | `POST /api/board-sources/webhooks/:provider[/:token]` | `NESSIE_RATE_LIMIT_BOARD_SOURCE_WEBHOOK_IP_` | 600 / min |
| `agentEmailInboundIp` | `POST /api/integrations/email/inbound` | `NESSIE_RATE_LIMIT_AGENT_EMAIL_INBOUND_IP_` | 600 / min |
| `executorDaemonIp` | `POST /api/executor-daemon/challenge` (pairing) | `NESSIE_RATE_LIMIT_EXECUTOR_DAEMON_IP_` | 60 / 10 min |
| `executorDaemonSessionIp` | daemon claim / heartbeat / descriptor / command poll + receipt, enrollment submit | `NESSIE_RATE_LIMIT_EXECUTOR_DAEMON_SESSION_IP_` | 6 000 / min |
| `publicRouteIp` | every other route declaring `config.public` | `NESSIE_RATE_LIMIT_PUBLIC_ROUTE_IP_` | 1 200 / min |

All seven executor-daemon routes pair through this table; none guards itself in
its handler.

## 4) Per-account lockout DoS tradeoff

Per-account limiting carries a known abuse cost — the same one NIST SP 800-63B
calls out for account-level throttling: anyone who knows a victim's email can
burn the victim's account bucket with failed attempts and lock the legitimate
user out of the password path until the window expires. We accept this tradeoff
deliberately:

- The per-IP cap still applies to every attempt, so forcing one account lockout
  costs the attacker their own IP budget (default 10 login attempts per 10 min
  per IP, with IPv6 bucketed per `/64`) — a mass lockout campaign needs a large
  address pool to be effective.
- Windows are fixed and short: the lockout self-heals at the next window
  (default 10 min) with no operator action and no persistent flag on the
  account.
- The victim keeps unaffected paths in the meantime: SSO code exchanges are
  keyed off the client IP only (the upstream identity is unknown until the
  exchange succeeds), and refresh tokens use their own separate buckets.

Tune the tradeoff with `NESSIE_RATE_LIMIT_LOGIN_ACCOUNT_MAX` /
`NESSIE_RATE_LIMIT_LOGIN_ACCOUNT_WINDOW_MS` (raising the max or shortening the
window makes a forced lockout harder) and `NESSIE_RATE_LIMIT_LOGIN_IP_*`
(raising the attacker-side cost per lockout).

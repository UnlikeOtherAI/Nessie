# Rate Limiting & Brute-Force Protection

> Status: implemented (issue #211).

## 1) Audit of what existed before

- `api/src/lib/rate-limit.ts` — in-process, per-instance fixed-window limiter
  covering only `POST /api/auth/session`, `POST /api/auth/bootstrap`
  (10/10 min), `POST /api/threads/:threadId/messages`, and agent mutation
  routes (60/min), keyed on Fastify's resolved `request.ip`. Process-local
  (resets on restart, diverges across replicas), per-IP only, no per-account
  dimension, no audit emission, and no coverage of token refresh, MCP OAuth,
  MCP secret writes, or step-up verification.
- `api/src/index.ts:132` — Fastify `trustProxy` is wired from
  `config.api.trustedProxyHops` via `createFastifyTrustProxyConfig`; hops `0`
  (default) ignores `X-Forwarded-For`.
- `api/src/lib/rate-limit.ts:18` — the limiter client id is `request.ip`,
  i.e. the proxy-aware Fastify IP; raw forwarded headers are never parsed by
  the limiter itself.
- `docs/deployment.md` — documented `NESSIE_API_TRUSTED_PROXY_HOPS` (`1`
  behind the production Caddy proxy) but no auth rate-limit thresholds.
- No `@fastify/rate-limit` dependency anywhere; no Redis in the stack.

## 2) Design

The audit surface above is unchanged for the generic routes it covers. Auth
brute-force protection lives in a dedicated Postgres-backed limiter at
`api/src/services/rate-limit.ts` (`RateLimiter`), constructed once in
`createServerContext` and threaded through `RouteDeps` / the MCP registrar
context.

- **Storage**: `rate_limit_buckets` (migration
  `20260724120000_auth_rate_limit_buckets`) — one row per
  `(bucket, key_hash, window_start)` with an atomic upsert-increment, safe
  across replicas and restarts. There is no Redis in this stack; Postgres is
  the only shared store and the auth endpoints already touch it per request.
  Windows are fixed rather than sliding so each identity costs one row per
  live window; ~2% of hits sweep rows from expired windows **within their own
  bucket** (buckets run on different windows, so a short-window sweep must
  never touch a longer bucket's live rows), keeping the table
  bounded by active keys with no background job.
- **Key hashing**: store keys are `sha256(bucket:identity)` — raw IPs and
  user ids are never persisted in the counters table. The bucket is the
  logical limiter name (`RATE_LIMIT_BUCKETS` in
  `api/src/routes/auth-rate-limit.ts`) and lives only in the store key, the
  audit resourceId, and the ops-health breakdown — never in the rule. Rules
  are plain `{max, windowMs}` thresholds so they load verbatim from config.
- **Per-IP AND per-account**: login, refresh, step-up, and MCP secret writes
  maintain both counters on every hit; the request is rejected when either
  trips, so one IP spraying many accounts hits the IP cap while one account
  attacked from many IPs hits the account cap. IPv6 client addresses are
  bucketed by their /64 prefix (the smallest routed allocation) so an
  attacker with a routed /64 cannot rotate addresses for fresh counters;
  IPv4 is bucketed per full address. The login account identity is the
  email normalized (`trim().toLowerCase()`) exactly like the account lookup
  in `loadSessionUserByEmail`, so case/whitespace variants of one address
  share a single counter.
- **Client IP**: always Fastify's resolved `request.ip`, which honours
  `X-Forwarded-For` only up to `NESSIE_API_TRUSTED_PROXY_HOPS` hops
  (`api/src/index.ts` `trustProxy`). Forwarded headers are never trusted
  otherwise.
- **429 + Retry-After**: rejected requests get `RATE_LIMITED` 429 with a
  `retry-after` header in seconds.
- **Audit**: a lockout emits exactly one `auth.rate_limit.lockout` audit
  event (`outcome: denied`) per bucket per window — on the transition, i.e.
  the hit that pushes the bucket's counter to `max + 1`. Requests rejected
  while the bucket is already locked out emit nothing: unauthenticated
  events serialize on the zero-org audit advisory lock, so per-request
  emission would make a flood of rejections costlier than acceptances and
  drown the audit table. Authenticated routes emit through the standard
  `emitAuditEvent` chokepoint under the caller's org hash chain.
  Unauthenticated routes (pre-login, refresh, OAuth callback) have no caller
  org, so the event is written under the synthetic zero-UUID system org with
  the true identity only as a hash in metadata.
- **Ops visibility**: cumulative `checks` / `limited` / `storeErrors` /
  `limitedByBucket` counters are exposed on `GET /api/ops/health`
  (`rateLimit`). They are per-process since boot.
- **Fail-open**: any store error (DB outage, missing migration) logs a loud
  `[rate-limit] FAIL-OPEN` line, increments `storeErrors`, and allows the
  request — availability beats lockout.
- **Exempt**: `/api/health`, `/api/health/ready`, and the realtime
  SSE/WebSocket streaming endpoints carry no limits.

## 3) Protected endpoints

| Surface | Route | Counters |
|---|---|---|
| Login | `POST /api/auth/session` | IP + account (email) |
| Token refresh | `POST /api/auth/refresh` | IP + account (presented token's user) |
| Bootstrap-owner exchange | `POST /api/auth/bootstrap` | IP |
| SSO authorize start | `GET /api/auth/providers/:id/authorize` | IP (covered below) |
| MCP OAuth start | `POST /api/mcp/instances/:id/oauth/start` | IP |
| MCP OAuth callback | `GET /api/mcp/oauth/callback` | IP |
| MCP secret writes | `PUT`/`DELETE /api/mcp/instances/:id/credentials…` | IP + account (actor) |
| Step-up verification | `POST /api/auth/password` (current-password re-proof) | IP + account (actor) |

## 4) Tuning

Every rule is `{max, windowMs}` under `api.rateLimit` in
`nessie.config.json`, each independently overridable via
`NESSIE_RATE_LIMIT_*` env vars — see the configuration reference in
[deployment.md](deployment.md). Defaults:

| Rule | Env prefix | Default |
|---|---|---|
| Login per IP | `NESSIE_RATE_LIMIT_LOGIN_IP_*` | 10 / 10 min |
| Login per account | `NESSIE_RATE_LIMIT_LOGIN_ACCOUNT_*` | 5 / 10 min |
| Refresh per IP | `NESSIE_RATE_LIMIT_REFRESH_IP_*` | 30 / 10 min |
| Refresh per account | `NESSIE_RATE_LIMIT_REFRESH_ACCOUNT_*` | 20 / 10 min |
| Bootstrap per IP | `NESSIE_RATE_LIMIT_BOOTSTRAP_IP_*` | 10 / 10 min |
| MCP OAuth per IP | `NESSIE_RATE_LIMIT_MCP_OAUTH_IP_*` | 20 / 10 min |
| MCP secret write per IP | `NESSIE_RATE_LIMIT_MCP_SECRET_WRITE_IP_*` | 20 / 10 min |
| MCP secret write per account | `NESSIE_RATE_LIMIT_MCP_SECRET_WRITE_ACCOUNT_*` | 10 / 10 min |
| Step-up per IP | `NESSIE_RATE_LIMIT_STEP_UP_IP_*` | 10 / 10 min |
| Step-up per account | `NESSIE_RATE_LIMIT_STEP_UP_ACCOUNT_*` | 5 / 10 min |

Each rule has a `_MAX` and `_WINDOW_MS` suffix (e.g.
`NESSIE_RATE_LIMIT_LOGIN_ACCOUNT_MAX=3`).

## 5) Per-account lockout DoS tradeoff

Per-account limiting carries a known abuse cost — the same one NIST SP
800-63B calls out for account-level throttling: anyone who knows a victim's
email can burn the victim's account bucket with failed attempts and lock
the legitimate user out of the password path until the window expires. We
accept this tradeoff deliberately:

- The per-IP cap still applies to every attempt, so forcing one account
  lockout costs the attacker their own IP budget (default 10 login attempts
  per 10 min per IP, with IPv6 bucketed per /64) — a mass lockout campaign
  needs a large address pool to be effective.
- Windows are fixed and short: the lockout self-heals at the next window
  (default 10 min) with no operator action and no persistent flag on the
  account.
- The victim keeps unaffected paths in the meantime: SSO code exchanges are
  keyed off the client IP only (the upstream identity is unknown until the
  exchange succeeds), and refresh tokens use their own separate buckets.

Tune the tradeoff with `NESSIE_RATE_LIMIT_LOGIN_ACCOUNT_MAX` /
`NESSIE_RATE_LIMIT_LOGIN_ACCOUNT_WINDOW_MS` (raising the max or shortening
the window makes a forced lockout harder) and `NESSIE_RATE_LIMIT_LOGIN_IP_*`
(raising the attacker-side cost per lockout).

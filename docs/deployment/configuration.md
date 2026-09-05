# Configuration reference

Chapter of [deployment.md](../deployment.md). Config layering and the full environment-variable table: Google scopes and Meet, object storage, agent email, connected mailboxes, the MCP secret store.

## Configuration reference

Runtime config is layered: `nessie.config.json` (mounted read-only into the API
and worker) ← environment variables (`ConfigEnvMap` in `packages/config`). Key
production settings:

| Setting | Where | Value |
|---------|-------|-------|
| Mode | `NESSIE_MODE` | `selfHosted` (disables dev login, requires CORS allowlist) |
| DB URL | `DATABASE_URL` / `NESSIE_DB_URL` | `postgresql://nessie:***@nessie-postgres:5432/nessie` |
| CORS | `NESSIE_CORS_ORIGINS` | `https://app.nessie.works,https://nessie.unlikeotherai.com` (Tauri origins are allowed in code: `tauri://localhost`, `http://tauri.localhost`) |
| Trusted proxy hops | `NESSIE_API_TRUSTED_PROXY_HOPS` | `1` behind the production Caddy proxy; default `0` ignores `X-Forwarded-For`. Also the single trust decision for all auth rate-limit client IP keys — set it correctly or every proxied client shares the proxy's IP bucket. |
| Auth brute-force limits | `NESSIE_RATE_LIMIT_*` (`_MAX` / `_WINDOW_MS` per rule) | Postgres-backed fixed-window counters (`rate_limit_buckets`) on login (`LOGIN_IP` 10/10min, `LOGIN_ACCOUNT` 5/10min), refresh (`REFRESH_IP` 30, `REFRESH_ACCOUNT` 20), bootstrap (`BOOTSTRAP_IP` 10), MCP OAuth start/callback (`MCP_OAUTH_IP` 20), MCP secret writes (`MCP_SECRET_WRITE_IP` 20, `MCP_SECRET_WRITE_ACCOUNT` 10), executor daemon challenges (`EXECUTOR_DAEMON_IP` 60), and step-up password re-proof (`STEP_UP_IP` 10, `STEP_UP_ACCOUNT` 5). Trips return 429 + `Retry-After` and emit an `auth.rate_limit.lockout` audit event; the store fails open with a loud log on outage. Counters on `/api/ops/health`. Full table: [rate-limiting.md](../rate-limiting.md) |
| Public API origin | `NESSIE_API_PUBLIC_URL` | `https://api.nessie.works` in production. Used to mint OAuth redirect URIs outside an HTTP request (personal-assistant `connector_authorize`); defaults to `http://localhost:<port>` |
| Public admin origin | `NESSIE_ADMIN_PUBLIC_URL` | `https://app.nessie.works` in production. UOA separately pins this origin on Nessie's billing lifecycle app key and authors Checkout/Portal return URLs; callers cannot supply or widen them through Nessie. |
| Ledger routing | `LEDGER_PUBLIC_URL`, `LEDGER_PROXY_TOKEN`, `LEDGER_DEEPWATER_MCP_URL`, `NESSIE_MODEL_BASE_URL`, `NESSIE_MODEL_API_KEY` | `LEDGER_PUBLIC_URL=https://ledger.unlikeotherai.com`; DeepWater uses `https://ledger.unlikeotherai.com/v1/mcp/deepwater`; builtin web search uses `/v1/serper/search`; configure inference with `https://ledger.unlikeotherai.com/v1/openai`, which Nessie rewrites per request to Ledger's `/v1/:serviceId/*` route for OpenAI, Kimi, MiniMax, DeepSeek, or a custom adapter. `LEDGER_PROXY_TOKEN` is Nessie's dedicated, product-bound Ledger app API key used for DeepWater and Serper; `NESSIE_MODEL_API_KEY` is configured with that same Nessie key for the Ledger model transport. Never reuse another product's app key or a webhook signing secret. Inference signing is best-effort by deployment and mandatory once available: with the `UOA_*` signer configured, every Ledger inference request carries signed non-null user/org/team/agent/run attribution, requires a linked SSO identity with UOA delegation, and fails before fetch when that identity is missing; with no signer configured at all, inference dispatches on `NESSIE_MODEL_API_KEY` alone and Ledger enforces per token whether signed provenance is also required (see "Ledger inference without UOA" below). Tool calls also carry their stable tool-call id. Direct provider keys, including `SERPER_API_KEY`, are not consumed. The deployment-wide model URL wins; when it is absent and an approved organization provider record resolves to Ledger, Nessie signs after route resolution. User-triggered background jobs persist origin and fail before provider dispatch if it cannot be resolved. Workflow execution additionally checks queued actor/scope against its durable run and installation. DeepWater enablement fails closed when its adapter URL, Nessie app API key, UOA signing/client settings, or first-party catalog is absent. Integration-managed instances reject generic test, refresh, healthcheck, secret, and delete operations; the Integrations toggle is their sole lifecycle path. Personal DeepWater credentials are unsupported. |
| UOA commercial billing boundary | `UOA_BILLING_APP_KEY_NESSIE`, `UOA_BILLING_ACTOR_PRIVATE_JWK_NESSIE`, `UOA_BASE_URL` | Nessie's own `uoa_app_` customer-lifecycle key bound in UOA to the `nessie` service, exact actor issuer/audience/key, public half of the dedicated RS256 actor key, and `https://app.nessie.works` return origin. The app key and private JWK are separate GitHub Actions secrets. The deploy runner cryptographically validates both before its dependency-free host installer atomically updates the root-readable `.env`; neither may be reused by Ledger or another product. Every credits/add-on read, top-up/automatic-top-up/add-on action, customer-statement, Checkout, Portal, cancellation-preview, cancellation-confirm, and direct-session access-confirmation request carries a fresh 45-second actor JWT for the exact linked UOA user/org/team, with the audience pinned to the exact endpoint path that request hits (derived from the validated request path at the point the request is built, never a hard-coded list). Direct access is confirmed only after direct SSO exchange and before local session issuance; UOA failure blocks login and indirect product use never calls the seam. Nessie fixed-allowlists UOA's action id/path/body and renders UOA's display-ready remaining-credit model; browsers cannot provide upstream paths, action bodies, return URLs, app keys, actor assertions, balances, or commercial calculations. |
| DeepSignal MCP boundary | `DEEPSIGNAL_MCP_APP_KEY` | DeepSignal-issued, Nessie-only `dsk_` application key. Required at API and worker startup in hosted/self-hosted modes and installed into the production host `.env` from the same-named GitHub Actions secret. It must differ from every configured secret-bearing environment credential (Ledger/model/billing, UOA signing/client, auth/session, DB, storage, email/admin, provider, push, or webhook credentials) and every encrypted per-org DeepSignal webhook signing secret; API and worker startup validate both boundaries. The user-scoped managed instance stores only this env reference; each outbound chat/history/digest/action request adds exact `ai.invoke` UOA delegation and fresh signed Nessie provenance independently. There is no OAuth or personal-credential fallback. |
| Auth secret | `NESSIE_AUTH_SECRET` | 32-byte hex; signs sessions, bootstrap tokens, and encrypts MCP OAuth secrets |
| Session TTLs | `NESSIE_AUTH_TOKEN_TTL`, `NESSIE_AUTH_REFRESH_TOKEN_TTL` | optional, seconds; access JWT default 1800 (30 min), rotating refresh cookie default 2592000 (30 days). See [auth spec](../deployment-modes-and-auth-spec/overview.md) |
| Model (chat) | `NESSIE_MODEL_PROVIDER`, `NESSIE_MODEL_BASE_URL`, `NESSIE_MODEL_API_KEY` | Hosted production routes OpenAI-compatible chat through Ledger; direct provider keys are not used by Nessie. A Ledger `NESSIE_MODEL_BASE_URL` always takes its bearer from `NESSIE_MODEL_API_KEY` and never inherits `OPENAI_API_KEY`/`OPENAI_CHAT_API_KEY`; startup fails if a Ledger URL is set with no key at all. |
| Agent avatar images | `NESSIE_LEDGER_IMAGE_PURPOSE_API_ID` | Optional. When set, agent-avatar "Generate with AI" routes image generation through this Ledger **Purpose API** (`/v1/purpose/:id/images/generations`) on `NESSIE_MODEL_BASE_URL`'s Ledger host, so Ledger owns the image provider fallback chain (e.g. Gemini image primary, OpenAI `gpt-image-2` fallback) behind one endpoint. Unset keeps the direct `/v1/openai/images/generations` service route, which fails when OpenAI's key is exhausted. Uses the same `NESSIE_MODEL_API_KEY` bearer and signed identity as chat; the token must hold a grant for that Purpose API. |
| Model (embeddings) | `NESSIE_EMBEDDING_PROVIDER`, `NESSIE_EMBEDDING_MODEL`, `NESSIE_EMBEDDING_SERVICE_ID`, `NESSIE_EMBEDDING_BASE_URL`, `NESSIE_EMBEDDING_API_KEY` | Optional; every unset field inherits the chat provider, so a deployment that sets none of these embeds exactly as before. Set them when the chat provider serves no embeddings endpoint — DeepSeek does not, and Ledger answers `403 embeddings is not allowed for deepseek`. `NESSIE_EMBEDDING_SERVICE_ID` is the Ledger `/v1/:serviceId/*` segment embeddings are rewritten to; without it the segment defaults to the provider name, which is meaningless for `openai-compatible`. Production uses `openai-compatible` + `jina` + `jina-embeddings-v3`, inheriting the Ledger host and key. **Changing the embedding model is a schema change** — see "Embedding model and vector width" below. |
| Auth providers (SSO) | `nessie.config.json` `auth.providers` | see SSO below |
| Feedback → GitHub | `NESSIE_GITHUB_TOKEN`, `NESSIE_GITHUB_OWNER`, `NESSIE_GITHUB_REPO` | token (repo-scoped PAT) required to file issues from the Feedback section; owner/repo default to `UnlikeOtherAI`/`Nessie`. Without a token, feedback is stored but no issue is created (`status: saved`) |
| Storage backend | `NESSIE_STORAGE_PROVIDER` | `s3` in prod (MinIO); `filesystem` in local dev |
| Storage endpoint | `NESSIE_STORAGE_ENDPOINT`, `NESSIE_STORAGE_REGION`, `NESSIE_STORAGE_FORCE_PATH_STYLE` | `http://nessie-minio:9000`, `us-east-1`, `true` (path-style is required for MinIO) |
| Storage bucket/creds | `NESSIE_STORAGE_BUCKET`, `NESSIE_STORAGE_ACCESS_KEY_ID`, `NESSIE_STORAGE_SECRET_ACCESS_KEY` | bucket defaults to `nessie`; the key id/secret double as the MinIO root user/password (host `.env`) |
| Max upload size | `NESSIE_MAX_UPLOAD_BYTES` | default `5368709120` (5 GiB); also pins the API multipart limit |
| Run backstop caps | `NESSIE_RUN_BACKSTOP_MAX_TOKENS`, `NESSIE_RUN_BACKSTOP_MAX_TOOL_CALLS`, `NESSIE_RUN_BACKSTOP_MAX_ITERATIONS`, `NESSIE_RUN_BACKSTOP_MAX_WALLCLOCK_MS`, `NESSIE_RUN_BACKSTOP_MAX_COST_CENTS` | optional; deployment-wide safety envelope for agent runs without explicit `Agent.runLimits` (defaults `500000` / `2000` / `1000` / `2700000` (45 min) / `2000`). Stops are graceful: checkpointed + classified notice |
| Cache-read token weight | `NESSIE_CACHE_READ_WEIGHT` | optional; fraction of the input-token price a cache-read token counts for against the run token budget when the org has no pricing rows for the model (default `0.25`). With pricing rows the weight is `cacheReadPerMillion / inputPerMillion` and this value is unused |
| Run auto-continuations | `NESSIE_RUN_AUTO_CONTINUATIONS` | optional; how many times a non-interactive (trigger/schedule/workflow) run auto-continues from its checkpoint after a cap stop (default `2`) |
| Delegate cap | `NESSIE_MAX_DELEGATES_PER_RUN` | optional; max `delegate` sub-agent calls per run (default `16`) |
| Utility model | `NESSIE_UTILITY_MODEL` | optional; model id used for context compaction + delegate sub-agents when it resolves through the run's own org provider (falls back to the run's model) |
| Builtin inline tool limit | `NESSIE_BUILTIN_INLINE_TOOL_LIMIT` | optional non-negative integer (default `20`). Allowed builtin sets at or below the limit keep every full descriptor byte-identical to the original form. Larger sets keep the fixed hot tools fully specified and expose curated, real-name stubs plus the non-mutating `tool_spec` schema lookup. |
| Disclosure containment | `NESSIE_DISCLOSURE_CONTAINMENT` | optional; **on by default**. A shared or autonomous run recalls only memories and past conversations the destination channel's own scope chain implies (organization → project → team → channel), so nothing cross-scope enters the run. Set to `off` / `false` / `0` to disable — do **not**, until the full disclosure boundary ships. The personal assistant is exempt (it acts as its owner, in a DM whose only human is that owner). See [plans/2026-08-11-disclosure-boundaries-build.md](../plans/2026-08-11-disclosure-boundaries-build.md) |
| Web Push public key | `NESSIE_WEBPUSH_PUBLIC_KEY` | optional; VAPID public key served to browsers. Enables browser web push when set with the two below. See [web-push.md](../web-push.md) |
| Web Push private key | `NESSIE_WEBPUSH_PRIVATE_KEY` | optional; VAPID private key that signs push JWTs (secret) |
| Web Push subject | `NESSIE_WEBPUSH_SUBJECT` | optional; VAPID subject, a `mailto:`/`https:` operator-contact URI. Generate the trio with `node scripts/generate-vapid-keys.mjs` |
| Connected mailboxes | `NESSIE_MAILBOX_TIMEOUT_MS` | SMTP/IMAP mailboxes people connect themselves. No configuration is required to enable them; this only bounds how long a mail server may take (default 20000 ms). See "Connected mailboxes (SMTP/IMAP)" below. |
| Agent email (SES) | `NESSIE_EMAIL_SES_REGION`, `NESSIE_EMAIL_DOMAIN`, `NESSIE_EMAIL_INBOUND_S3_BUCKET`, `NESSIE_EMAIL_SNS_TOPIC_ARN` (+ optional `NESSIE_EMAIL_SES_ACCESS_KEY_ID`/`_SECRET_ACCESS_KEY`, `NESSIE_EMAIL_INBOUND_S3_PREFIX`, `NESSIE_EMAIL_CONFIGURATION_SET`, `NESSIE_EMAIL_INBOUND_RETENTION_DAYS`, `NESSIE_EMAIL_CUSTOM_DOMAINS`, `NESSIE_AGENT_MAIL_MAX_SENDS_PER_HOUR`, `NESSIE_AGENT_MAIL_MAX_INBOUND_BYTES`) | Hosted agent mailboxes. All four required fields must be present or the feature stays off and names the missing ones; credentials omitted ⇒ the AWS SDK default chain (instance profile / IRSA). Full AWS setup, IAM and operating notes: "Agent email (Amazon SES)" below. |
| Comms Slack client id | `NESSIE_COMMS_SLACK_CLIENT_ID` | optional; Slack app OAuth client id for the Individual Communications Connector. Also read by the API OAuth-start (`oauth-config.ts`) to build the authorize URL |
| Comms Slack client secret | `NESSIE_COMMS_SLACK_CLIENT_SECRET` | optional (secret); Slack app OAuth client secret used for the code→token exchange |
| Comms Slack signing secret | `NESSIE_COMMS_SLACK_SIGNING_SECRET` | optional (secret); Slack Events API request-signing secret (`v0` HMAC). Slack registers only when all three of the above are set |
| Comms Google client id | `NESSIE_COMMS_GOOGLE_CLIENT_ID` | optional; Google OAuth client id for the Gmail + Meet connector. Also read by the API OAuth-start |
| Comms Google client secret | `NESSIE_COMMS_GOOGLE_CLIENT_SECRET` | optional (secret); Google OAuth client secret for the code→token exchange. Google and the `google_meet` call provider are configured only when the id + secret are both set |
| Comms Google Pub/Sub topic | `NESSIE_COMMS_GOOGLE_PUBSUB_TOPIC` | optional; fully-qualified `projects/<p>/topics/<t>` for Gmail `users.watch` push notifications. Sync still works without it (incremental polling); only real-time watch renewal needs it |
| Comms Microsoft client id | `NESSIE_COMMS_MICROSOFT_CLIENT_ID` | optional; Microsoft Entra OAuth application client id for personal Outlook mail. Enables Microsoft discovery and OAuth start. Register the exact callback `${NESSIE_API_PUBLIC_URL}/api/comms/connections/microsoft/callback` and allow personal or organisational accounts as required. |
| Comms Microsoft client secret | `NESSIE_COMMS_MICROSOFT_CLIENT_SECRET` | optional (secret) for a confidential web-client registration; omit only when the Entra application is deliberately configured as a PKCE public client. API and worker must receive the same registration values. |
| Jitsi call domain | `NESSIE_JITSI_DOMAIN` | optional; hostname (and optional port) used for server-minted Jitsi links. Defaults to `meet.jit.si`; do not include a scheme or path |
| Call ring timeout | `NESSIE_CALL_RING_TIMEOUT_MS` | optional; delayed durable queue timeout for an unanswered call. Defaults to `45000` (45 seconds). Never implemented with an API-process timer. |
| Active-call expiry | `NESSIE_CALL_MAX_ACTIVE_HOURS` | optional; worker sweep backstop for a call that remains active without an explicit end. Defaults to `8` hours. |

Communications connectors register from env at API and worker startup via
`@nessie/comms-providers`; a provider whose vars are unset simply does not
register, and its sync jobs park cleanly on `ConnectorNotRegisteredError`.
Startup logs one line listing the registered providers (no secrets).

### Google scopes, capabilities and verification tiers

Each deployment registers its **own** Google Cloud OAuth client, so the
verification burden is yours, not Nessie's. Which scopes a connection may ask
for is declared in `packages/schemas/src/google-capabilities.ts`; the
Permissions section of `/settings/connections` renders that catalog and lets a
person grant one capability at a time without reconnecting.

Google sorts the relevant scopes into tiers, and the tier decides the review:

| Capability | Scope | Tier |
|---|---|---|
| `gmail.read` | `gmail.readonly` | restricted |
| `gmail.compose` | `gmail.compose` | restricted |
| `gmail.modify` | `gmail.modify` | restricted |
| `gmail.send` | `gmail.send` | sensitive |
| `calendar.read` / `calendar.freebusy` / `calendar.write` | `calendar.readonly` / `calendar.freebusy` / `calendar.events` | sensitive |
| `meet.create` | `meetings.space.created` | sensitive |
| `contacts.read` | `contacts.readonly`, `directory.readonly` | sensitive |

**Restricted** scopes require Google's CASA security assessment for a *public*
OAuth client. The internal-use exception is narrower than "we self-host": it
applies only when every user belongs to the **same** Team/Cloud Identity
organization, the Cloud project is owned by that organization, **and** the
consent screen is set to **Internal**. A deployment serving users outside one
Team org needs the assessment before it can ask for `gmail.readonly` or
`gmail.compose`. Sending alone (`gmail.send`) is only *sensitive*, so a
send-only deployment avoids the assessment entirely.

Re-confirm these tiers against Google's current OAuth verification FAQ before
enabling a capability; Google moves scopes between tiers.

Two consequences worth knowing operationally:

- **Google cannot revoke one scope.** `/revoke` ends the whole grant. Removing
  a single capability is therefore a *local* block, enforced when a tool asks
  for a credential; the connection still holds the scope at Google until the
  person disconnects.
- **A person can decline individual scopes** on the consent screen. Nessie
  stores what Google returned, so a partially-granted connection shows the
  refused capability as "Declined at Google" rather than silently behaving as
  though it were granted.

### Google Meet link setup

Google Meet link minting uses the existing per-user Google communications OAuth
connection. Before offering `google_meet` as a team's call provider:

1. Select the Google Cloud project that owns the configured OAuth client and
   enable the Meet REST API:

   ```sh
   gcloud config set project <project-id>
   gcloud services enable meet.googleapis.com
   ```

2. In Google Cloud Console, update the OAuth consent screen to declare
   `https://www.googleapis.com/auth/meetings.space.created`. Google classifies
   this as a Sensitive scope; it permits managing Meet spaces this application
   created, not only creating them. Complete Google's production verification
   before deployment.
3. Keep the existing web OAuth client and callback URI, and configure its id and
   secret through `NESSIE_COMMS_GOOGLE_CLIENT_ID` and
   `NESSIE_COMMS_GOOGLE_CLIENT_SECRET`. Consent-screen and external web-client
   management are Console steps; `gcloud` does not expose a general API for
   them.
4. Put an external consent screen into **In production** status. Testing mode is
   capped at 100 test users and its refresh tokens expire after seven days.

New and reauthorized Google connections request the Meet scope incrementally
with `include_granted_scopes=true`. Existing connections that lack it receive a
typed `MEET_SCOPE_MISSING` refusal and must be reauthorized; Nessie never
silently widens a user's grant.

### Object storage (MinIO)

File uploads — chat attachments, avatars/logos, and knowledge-base **file nodes**
+ **page attachments** — are stored in object storage through the single
`@nessie/runtime` `FileService`. Production runs a dedicated `nessie-minio`
container on the `db` network (the shared host has no S3); `nessie-minio-setup`
creates the bucket on each deploy. Set `NESSIE_STORAGE_ACCESS_KEY_ID` /
`NESSIE_STORAGE_SECRET_ACCESS_KEY` (and optionally `NESSIE_STORAGE_BUCKET`) in the
host `.env` — they are the MinIO root credentials and the app's S3 credentials.
Local dev keeps `filesystem` (zero setup); to exercise the S3 path locally, run a
MinIO container and set the `NESSIE_STORAGE_*` vars.

Uploads that can be previewed also get a small WebP **thumbnail** stored beside
the original (`<key>.thumb.webp`) so chat feeds never transfer a full-resolution
file to paint a preview. Raster images are thumbnailed inline at upload; PDFs and
awkward image formats go through the `attachment.thumbnail` worker job. PDF first
pages are rasterized by **`@hyzyla/pdfium`**, a pure-WebAssembly build of PDFium:
it needs **no system packages and no per-architecture native binaries**, so the
`Dockerfile.app` image is unchanged and stays architecture-independent. Keep it
that way — a native PDF or video renderer would add hundreds of megabytes per
architecture, and the GPL/AGPL options (MuPDF, Poppler, ffmpeg) are not
licence-compatible with this product. No new environment variables.

Every store/delete updates the `storage_usage_events` ledger, so per-org/team/
space/uploader usage is always known; thumbnails are quota-gated with their
original and write their own `store.thumbnail` / `delete.thumbnail` events, so
usage stays an exact sum. A per-scope cap (`Budget.storageLimitBytes`)
blocks uploads (HTTP 507) when exceeded. The cap is set in the admin **Budgets**
screen ("Storage cap (GB)") alongside spend caps, and current usage shows in the
knowledge-base header. `MinIO` data lives in the `nessie_miniodata` volume — back
it up alongside `nessie_pgdata`.

### Agent email (Amazon SES)

Hosted agent mailboxes give each agent its own address (`support@nessie.works`).
Amazon SES is integrated **directly** — the deployment's own account sends and
receives, so an address is unique per deployment and there is no intermediary
service.

The feature is **off unless configured**, and partial configuration is named
rather than degraded: the claim flow refuses with `AGENT_MAIL_UNCONFIGURED`
listing the missing variables, the agent's Email section shows an owner that
same list, the inbound route answers `503`, and the worker logs
`[worker.agent-email] disabled` at boot and registers no handlers. Required:
`NESSIE_EMAIL_SES_REGION`, `NESSIE_EMAIL_DOMAIN`,
`NESSIE_EMAIL_INBOUND_S3_BUCKET`, `NESSIE_EMAIL_SNS_TOPIC_ARN`. Credentials are
optional — omit them to use the AWS SDK default chain (instance profile / IRSA).

**Authoritative guide: [docs/agent-email.md](../agent-email.md)** — the full AWS
click-path and CLI (domain + DKIM, MX, the receipt rule into S3 + SNS, the
configuration set, IAM, self-subscription), every environment variable,
verification commands, and the operating rules that matter in production
(deployment-wide suppression, why an ambiguous send is never retried, and why a
deleted address is retired permanently).

### Connected mailboxes (SMTP/IMAP)

The other half of agent email needs **no deployment configuration at all**: a
person or a team connects a mailbox that already exists, the provider keeps the
mail, and nothing is stored here but a password sealed with `NESSIE_AUTH_SECRET`
and an audit trail. The only setting is `NESSIE_MAILBOX_TIMEOUT_MS` (default
`20000`), which bounds how long a mail server may take per read.

The address-first discovery route uses the reviewed provider registry, MX
fingerprints, secure mail/JMAP/Exchange-Online SRV records, and domain-owned
HTTPS autoconfiguration. It never receives a password. Its HTTPS requests use
the shared SSRF-safe pinned transport, same-origin redirect policy, a 64 KiB
response cap, and a three-second shared deadline. JMAP is detected but is not a
runtime connector yet; unknown, contradictory, or uncorroborated external SRV
results go to Advanced settings instead of becoming a credential destination.
Google and Microsoft discovery offer OAuth only when their connector
registration above is present. Apple third-party authorization is not
registered by Nessie today, so iCloud uses its reviewed app-specific-password
IMAP/SMTP path.

Worth knowing when locking a network down: the API and the worker open raw TCP
connections to the IMAP and SMTP hosts people configure — always over TLS, and
always to an address vetted against the same private-range rules as HTTP egress.
Guide: [docs/connected-mailboxes.md](../connected-mailboxes.md).

### MCP OAuth secret store

`api/src/services/mcp-oauth-secret-store.ts` provides a persistent,
AES-256-GCM-encrypted Postgres-backed `SecretStore` (table `mcp_oauth_secret`,
keyed off `NESSIE_AUTH_SECRET`). The API requires this in production — the MCP
route registrar refuses to boot with the in-memory stub under
`NODE_ENV=production`. **Known follow-up:** the read side
(`createPgSecretResolver`) is implemented but the worker/API tool dispatchers
still default to `NullSecretResolver` (a pre-existing phase-3 deferral), so
OAuth-authorized MCP connector tokens are stored securely but not yet consumed by
the agent loop.

User-authored MCP connectors are limited to HTTP/SSE remote endpoints. The API
and worker reject stdio process execution from catalog or instance data, and
MCP endpoint plus OAuth authorization/token URLs must pass the shared SSRF guard
before save or use. Private, local, link-local, and metadata-network targets
should be exposed through remote MCP runners instead of direct cloud callbacks.

### Project board sources (Jira, Linear, Trello, GitHub)

A project's boards can mirror work from another system
([the design](../plans/2026-09-05-project-boards-external-sources-and-custom-fields.md)).
Each provider needs an app registered with the vendor **once per deployment**;
a person then connects their own account to it.

**A provider with no credentials here is not registered.** It is absent from
the connect picker rather than offered and broken, and any queued job naming it
parks with `PROVIDER_NOT_CONFIGURED` instead of failing in a way that reads like
an outage. Configuring one is the only thing that turns it on — there is no
per-organisation switch.

| Variable | Provider | Where it comes from |
| --- | --- | --- |
| `NESSIE_BOARD_LINEAR_CLIENT_ID` / `_SECRET` | Linear | An OAuth application in Linear's workspace settings. Redirect URI: `<NESSIE_API_PUBLIC_URL>/api/board-sources/connections/linear/callback` |
| `NESSIE_BOARD_LINEAR_WEBHOOK_SECRET` | Linear | The signing secret of the app's webhook, if one is configured. Without it Linear syncs on its five-minute poll only. |
| `NESSIE_BOARD_JIRA_CLIENT_ID` / `_SECRET` | Jira Cloud | An OAuth 2.0 (3LO) app in the Atlassian developer console, with `read:jira-work write:jira-work read:jira-user offline_access`. Same callback path with `/jira/`. |
| `NESSIE_BOARD_GITHUB_CLIENT_ID` / `_SECRET` | GitHub | An OAuth app or GitHub App. Scopes `repo read:project read:org`. Same callback path with `/github/`. |
| `NESSIE_BOARD_GITHUB_WEBHOOK_SECRET` | GitHub | The app's webhook secret, for `X-Hub-Signature-256` verification. |
| `NESSIE_BOARD_TRELLO_API_KEY` / `_API_SECRET` | Trello | A Power-Up's key and secret. Trello has no authorization-code flow: the person's token arrives in a URL fragment and is submitted once to `/api/board-sources/connections/trello/complete`, then encrypted. |

`NESSIE_API_PUBLIC_URL` must be set for webhooks: it is what the worker uses to
mint the callback URL it registers with the vendor. Without it, sources still
sync on their polling interval.

Credentials are encrypted at rest with the deployment's `NESSIE_AUTH_SECRET`
through the same sealed-secret seam the communications connector and the MCP
secret store use, in `board_source_connection_credentials`. No route returns
them, and only `loadBoardSourceConnectionContext` decrypts one.

Jira's webhooks are unsigned and expire after 30 days, so a Jira source carries
a per-source callback token whose **hash** is all that is stored; a delivery
that cannot present the token is dropped. Every other provider signs its
deliveries with the app secret above.

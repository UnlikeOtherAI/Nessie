import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { assertLocalOnlyCapability, FILESYSTEM_STORAGE } from './local-only.js'

// The single-host capability rule lives in its own module (this file is long
// enough); it is re-exported here because `.` is the package's only entry.
export {
  assertLocalOnlyCapability,
  DOCKER_EXECUTION_PROVIDER,
  FILESYSTEM_BUILTIN_TOOLS,
  FILESYSTEM_STORAGE,
  localOnlyCapabilityMessage,
  SingleInstanceCapabilityError,
} from './local-only.js'
export type { LocalOnlyCapability } from './local-only.js'

export const NessieModeSchema = z.enum(['hosted', 'selfHosted', 'local'])
export type NessieMode = z.infer<typeof NessieModeSchema>

export const AuthProviderTypeSchema = z.enum([
  'oidc',
  'saml',
  'uoa',
  'local-bootstrap',
  'custom',
])
export type AuthProviderType = z.infer<typeof AuthProviderTypeSchema>

export const AuthProviderConfigSchema = z.object({
  providerId: z.string().min(1),
  type: AuthProviderTypeSchema,
  label: z.string().min(1),
  enabled: z.boolean().default(true),
  autoRedirect: z.boolean().default(false),
  issuerUrl: z.string().url().optional(),
  clientId: z.string().min(1).optional(),
  scopes: z.array(z.string().min(1)).default([]),
  mappingRules: z.record(z.string(), z.string()).default({}),
})
export type AuthProviderConfig = z.infer<typeof AuthProviderConfigSchema>

export const StorageProviderSchema = z.enum(['filesystem', 'gcs', 's3'])
export type StorageProvider = z.infer<typeof StorageProviderSchema>

export const QueueProviderSchema = z.enum(['pubsub', 'local'])
export type QueueProvider = z.infer<typeof QueueProviderSchema>

export const ModelProviderSchema = z.enum(['openai', 'kimi', 'deepseek'])
export type ModelProvider = z.infer<typeof ModelProviderSchema>

export const ModelConfigSchema = z.object({
  provider: ModelProviderSchema,
  apiKey: z.string().min(1).optional(),
  baseUrl: z.string().url().optional(),
  // Ledger's provider proxy is `/v1/:serviceId/*`, and the segment is the
  // service Ledger registers — not necessarily one of the three providers
  // Nessie compiles an adapter for. Naming it here is what lets the
  // deployment default sit on a Ledger service with no compiled adapter (for
  // example Meta's `muse-spark-*`), which reaches Ledger through the generic
  // OpenAI-compatible connector. Unset keeps today's behaviour: the segment
  // defaults to `provider`. Mirrors `embedding.serviceId`.
  serviceId: z.string().min(1).regex(/^[A-Za-z0-9._-]+$/).optional(),
  maxTokens: z.number().int().positive().default(2048),
  modelName: z.string().min(1).optional(),
  temperature: z.number().min(0).max(2).default(0.2),
  // When set, agent-avatar image generation routes through this Ledger Purpose
  // API (`/v1/purpose/:id/images/generations`) instead of the direct
  // `/v1/openai/images/generations` service route, so Ledger owns the image
  // provider fallback chain (e.g. Gemini primary, OpenAI fallback). Unset keeps
  // the direct OpenAI route.
  imagePurposeApiId: z.string().min(1).optional(),
  backends: z.array(
    z.string().url(),
  ).default([]).refine(
    (urls) => urls.map((u) => new URL(u)).every(
      (parsed) =>
        parsed.protocol === 'https:' &&
        !['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname),
    ),
    {
      message:
        'Backends must be https:// URLs and cannot point to localhost, 127.0.0.1, or internal metadata endpoints',
    },
  ),
})
export type ModelConfig = z.infer<typeof ModelConfigSchema>

// Embeddings do not have to come from the chat provider. Chat routes through
// whichever model the deployment picked (DeepSeek, Kimi, …); embeddings need a
// provider that actually serves an embeddings endpoint at the width
// `EMBEDDING_DIMENSIONS` pins. Every field is optional and every unset field
// falls back to the chat provider's, so a deployment that configures none of
// these embeds exactly as it did before this block existed.
export const EmbeddingProviderSchema = z.enum([
  'openai',
  'kimi',
  'deepseek',
  'openai-compatible',
])
export type EmbeddingProvider = z.infer<typeof EmbeddingProviderSchema>

export const EmbeddingConfigSchema = z.object({
  provider: EmbeddingProviderSchema.optional(),
  apiKey: z.string().min(1).optional(),
  baseUrl: z.string().url().optional(),
  modelName: z.string().min(1).optional(),
  // Ledger's provider proxy is `/v1/:serviceId/*`. A Ledger base URL is
  // rewritten to this segment, which is how embeddings reach `/v1/jina` while
  // chat stays on `/v1/deepseek`. Defaults to the provider name, which is only
  // meaningful for a provider Ledger exposes under its own name.
  serviceId: z.string().min(1).regex(/^[A-Za-z0-9._-]+$/).optional(),
})
export type EmbeddingConfig = z.infer<typeof EmbeddingConfigSchema>

const RateLimitRuleSchema = z.object({
  max: z.number().int().positive(),
  windowMs: z.number().int().positive(),
})

export const NessieConfigSchema = z.object({
  mode: NessieModeSchema,
  // Hard ceiling on graceful shutdown. Every long-lived process (API, gateway)
  // arms a timer for this long when it starts draining and calls
  // `process.exit(1)` if the drain has not finished, so a wedged stream or a
  // hung pool cannot outlive the orchestrator's own grace period. Keep it
  // comfortably below that period (Kubernetes `terminationGracePeriodSeconds`,
  // Cloud Run's 10 s, `docker stop -t`) or the runtime SIGKILLs first and the
  // drain buys nothing.
  shutdownTimeoutMs: z.number().int().positive().default(25_000),
  auth: z.object({
    providers: z.array(AuthProviderConfigSchema),
    autoRedirectToSso: z.boolean().default(false),
    secret: z.string().min(1).optional(),
    // Access JWT is short-lived (30 min); the long-lived refresh token (30 days)
    // in an httpOnly cookie silently renews it. See docs/deployment-modes-and-auth-spec.md.
    tokenTtlSeconds: z.number().int().positive().default(30 * 60),
    refreshTokenTtlSeconds: z.number().int().positive().default(30 * 24 * 60 * 60),
  }),
  database: z.object({
    url: z.string().min(1),
    poolMin: z.number().int().nonnegative().default(2),
    poolMax: z.number().int().positive().default(10),
  }),
  storage: z.object({
    provider: StorageProviderSchema,
    bucket: z.string().min(1).optional(),
    localPath: z.string().min(1).optional(),
    // S3-compatible (MinIO) settings — only consulted when provider is 's3'.
    endpoint: z.string().min(1).optional(),
    region: z.string().min(1).optional(),
    forcePathStyle: z.boolean().optional(),
    accessKeyId: z.string().min(1).optional(),
    secretAccessKey: z.string().min(1).optional(),
    // Upload ceiling shared by API multipart limits and the FileService quota
    // pre-check. Defaults to 5 GiB.
    maxUploadBytes: z.number().int().positive().default(5 * 1024 * 1024 * 1024),
  }),
  queue: z.object({
    provider: QueueProviderSchema,
    projectId: z.string().min(1).optional(),
  }),
  model: ModelConfigSchema,
  embedding: EmbeddingConfigSchema.default({}),
  api: z.object({
    host: z.string().min(1).default('0.0.0.0'),
    port: z.number().int().positive().default(5454),
    trustedProxyHops: z.number().int().nonnegative().default(0),
    // Brute-force limits for auth-sensitive endpoints (api/src/services/rate-limit.ts).
    // Fixed-window counters stored in Postgres (`rate_limit_buckets`); every rule is
    // `{max, windowMs}` and independently env-tunable. Defaults below mirror
    // DEFAULT_RATE_LIMIT_CONFIG and docs/deployment.md.
    rateLimit: z.object({
      loginIp: RateLimitRuleSchema.default({ max: 10, windowMs: 10 * 60_000 }),
      loginAccount: RateLimitRuleSchema.default({ max: 5, windowMs: 10 * 60_000 }),
      refreshIp: RateLimitRuleSchema.default({ max: 30, windowMs: 10 * 60_000 }),
      refreshAccount: RateLimitRuleSchema.default({ max: 20, windowMs: 10 * 60_000 }),
      bootstrapIp: RateLimitRuleSchema.default({ max: 10, windowMs: 10 * 60_000 }),
      mcpOauthIp: RateLimitRuleSchema.default({ max: 20, windowMs: 10 * 60_000 }),
      mcpSecretWriteIp: RateLimitRuleSchema.default({ max: 20, windowMs: 10 * 60_000 }),
      mcpSecretWriteAccount: RateLimitRuleSchema.default({ max: 10, windowMs: 10 * 60_000 }),
      executorDaemonIp: RateLimitRuleSchema.default({ max: 60, windowMs: 10 * 60_000 }),
      stepUpIp: RateLimitRuleSchema.default({ max: 10, windowMs: 10 * 60_000 }),
      stepUpAccount: RateLimitRuleSchema.default({ max: 5, windowMs: 10 * 60_000 }),
      // Polling is legitimately repetitive — a person may sit on the code
      // screen for a minute or two — so the account allowance is generous
      // while still bounding what one member can aim at the provider.
      subscriptionDeviceIp: RateLimitRuleSchema.default({ max: 240, windowMs: 10 * 60_000 }),
      subscriptionDeviceAccount: RateLimitRuleSchema.default({ max: 120, windowMs: 10 * 60_000 }),
      // SSO authorize-URL minting used to borrow `mcpOauthIp`'s thresholds
      // because it had no rule of its own; it is a different surface and now
      // carries one (2026-09-05 review, FO3-7). Same starting numbers.
      ssoAuthorizeIp: RateLimitRuleSchema.default({ max: 20, windowMs: 10 * 60_000 }),
      // --- Buckets applied by the global hook (api/src/routes/auth-rate-limit.ts).
      // These four replace the hard-coded in-process limiter that used to run
      // beside this one with its own thresholds and its own IP keying
      // (2026-09-05 review, FO3-3/FO4-1); the numbers are the ones that
      // limiter carried.
      threadMessageIp: RateLimitRuleSchema.default({ max: 60, windowMs: 60_000 }),
      // Discovery fans one address out to DNS and several bounded HTTPS
      // requests, so it needs an IP budget even though it is authenticated.
      mailboxDiscoverIp: RateLimitRuleSchema.default({ max: 30, windowMs: 60_000 }),
      agentWriteIp: RateLimitRuleSchema.default({ max: 60, windowMs: 60_000 }),
      // `GET /api/auth/me` is public and counts users when unauthenticated.
      authMeIp: RateLimitRuleSchema.default({ max: 600, windowMs: 60_000 }),
      // Unauthenticated key-guessing surface: a bearer webhook key is the only
      // thing between a caller and a trigger fire, so this is the tightest of
      // the intake buckets.
      triggerWebhookIp: RateLimitRuleSchema.default({ max: 120, windowMs: 60_000 }),
      commsWebhookIp: RateLimitRuleSchema.default({ max: 600, windowMs: 60_000 }),
      boardSourceWebhookIp: RateLimitRuleSchema.default({ max: 600, windowMs: 60_000 }),
      agentEmailInboundIp: RateLimitRuleSchema.default({ max: 600, windowMs: 60_000 }),
      // The executor daemon's session routes (claim/heartbeat/descriptor/
      // command poll + receipt/enrollment submit). `executorDaemonIp` above
      // governs the pairing challenge only: the daemon polls for commands once
      // a second (executor/src/daemon.ts), so several daemons behind one NAT
      // legitimately produce a high steady rate and this is a flood ceiling,
      // not a per-daemon budget.
      executorDaemonSessionIp: RateLimitRuleSchema.default({ max: 6_000, windowMs: 60_000 }),
      // Coverage-by-default floor for every route declaring `config.public`
      // that does not name a bucket above, so a new public route is limited
      // from the moment it exists instead of when somebody remembers
      // (2026-09-05 review, FO3-7/F5-5). Deliberately generous: it is a flood
      // ceiling for an unauthenticated origin, and routes that need a real
      // budget name their own bucket. A route that already guards itself in
      // its handler still counts here — the floor is additional, never a
      // replacement.
      publicRouteIp: RateLimitRuleSchema.default({ max: 1_200, windowMs: 60_000 }),
    }).default({}),
    // Public origin of the API as reachable from a user's browser (e.g.
    // https://api.nessie.works). Used to build OAuth redirect URIs minted
    // outside an HTTP request (the worker's personal assistant). Defaults to
    // localhost:{port} for local dev.
    publicUrl: z.string().url().optional(),
  }),
  // GitHub integration for the in-app Feedback section: submitted feedback
  // becomes an issue in this repo. The token is required to actually create
  // issues; without it feedback is still stored (status "saved").
  github: z
    .object({
      token: z.string().min(1).optional(),
      // Restrict to the GitHub owner/repo charset — these are interpolated into
      // the issues API URL, so a stray slash must not redirect the token.
      owner: z.string().min(1).regex(/^[A-Za-z0-9_.-]+$/).default('UnlikeOtherAI'),
      repo: z.string().min(1).regex(/^[A-Za-z0-9_.-]+$/).default('Nessie'),
    })
    .default({ owner: 'UnlikeOtherAI', repo: 'Nessie' }),
  // Web Push (browser notifications) VAPID application-server keys. One key
  // pair per instance, generated via `node scripts/generate-vapid-keys.mjs`.
  // The public key is served to browsers so they can subscribe; the private
  // key signs the per-request VAPID JWT in the worker. Absent ⇒ web push off.
  webPush: z
    .object({
      publicKey: z.string().min(1).optional(),
      privateKey: z.string().min(1).optional(),
      subject: z.string().min(1).optional(),
    })
    .default({}),
  // Hosted agent mailboxes (docs/plans/2026-09-02-agent-email.md Model B).
  // Amazon SES is integrated directly: the deployment's own SES account sends
  // and receives, so an address is unique per deployment and no intermediary
  // service exists. The feature is OFF unless region + domain + inbound bucket
  // + SNS topic are all present; partial configuration is named at startup
  // rather than degraded silently (see `resolveAgentEmailReadiness`).
  // Credentials are optional: with none set the AWS SDK default chain applies,
  // which is how an instance profile / IRSA role is used.
  email: z
    .object({
      sesRegion: z.string().min(1).optional(),
      accessKeyId: z.string().min(1).optional(),
      secretAccessKey: z.string().min(1).optional(),
      domain: z.string().min(1).optional(),
      inboundBucket: z.string().min(1).optional(),
      inboundPrefix: z.string().default(''),
      snsTopicArn: z.string().min(1).optional(),
      configurationSet: z.string().min(1).optional(),
      inboundRetentionDays: z.number().int().nonnegative().default(30),
      customDomains: z.boolean().default(false),
      maxSendsPerHour: z.number().int().positive().default(30),
      maxInboundBytes: z.number().int().positive().default(25 * 1024 * 1024),
    })
    .default({}),
  // Automatic team access after sign-in, by DNS-verified email domain
  // (docs/plans/2026-09-04-automatic-team-membership-by-verified-domain.md).
  // The instance rollout gate, and the one that is fail-closed: with it off the
  // routes answer 404 and the admin tab is absent. The per-organisation
  // emergency stop is a ScopedSetting, not another env var.
  automaticMembership: z
    .object({
      enabled: z.boolean().default(false),
    })
    .default({}),
})
export type NessieConfig = z.infer<typeof NessieConfigSchema>

// No `hasRedis`: `redis.enabled` had no environment mapping and nothing ever
// read `config.redis`, so the capability was false on every deployment that
// has ever run. Postgres is the queue and the realtime bus by decision
// (docs/standards/horizontal-scaling.md), so there is nothing for it to
// describe.
export const RuntimeCapabilitiesSchema = z.object({
  hasObjectStorage: z.boolean(),
  hasExternalAuth: z.boolean(),
  hasPubSub: z.boolean(),
  hasModelProvider: z.boolean(),
})
export type RuntimeCapabilities = z.infer<typeof RuntimeCapabilitiesSchema>

export const ConfigEnvMap = {
  NESSIE_MODE: 'mode',
  NESSIE_AUTH_AUTO_REDIRECT: 'auth.autoRedirectToSso',
  NESSIE_AUTH_SECRET: 'auth.secret',
  NESSIE_AUTH_TOKEN_TTL: 'auth.tokenTtlSeconds',
  NESSIE_AUTH_REFRESH_TOKEN_TTL: 'auth.refreshTokenTtlSeconds',
  NESSIE_DB_URL: 'database.url',
  // Postgres pool sizing per process. Until these existed only
  // `nessie.config.json` could move them, so a containerised deployment was
  // pinned to the 10/2 defaults; at ~21 connections per API replica
  // (`poolMax * 2 + 1` — the arithmetic is spelled out in `api/src/index.ts`,
  // which owns it) that is what makes the connection ceiling scale with
  // replica count.
  NESSIE_DB_POOL_MAX: 'database.poolMax',
  NESSIE_DB_POOL_MIN: 'database.poolMin',
  NESSIE_SHUTDOWN_TIMEOUT_MS: 'shutdownTimeoutMs',
  NESSIE_STORAGE_PROVIDER: 'storage.provider',
  NESSIE_STORAGE_BUCKET: 'storage.bucket',
  NESSIE_STORAGE_LOCAL_PATH: 'storage.localPath',
  NESSIE_STORAGE_ENDPOINT: 'storage.endpoint',
  NESSIE_STORAGE_REGION: 'storage.region',
  NESSIE_STORAGE_FORCE_PATH_STYLE: 'storage.forcePathStyle',
  NESSIE_STORAGE_ACCESS_KEY_ID: 'storage.accessKeyId',
  NESSIE_STORAGE_SECRET_ACCESS_KEY: 'storage.secretAccessKey',
  NESSIE_MAX_UPLOAD_BYTES: 'storage.maxUploadBytes',
  NESSIE_QUEUE_PROVIDER: 'queue.provider',
  NESSIE_QUEUE_PROJECT_ID: 'queue.projectId',
  NESSIE_MODEL_PROVIDER: 'model.provider',
  NESSIE_MODEL_API_KEY: 'model.apiKey',
  NESSIE_MODEL_BASE_URL: 'model.baseUrl',
  NESSIE_MODEL_MAX_TOKENS: 'model.maxTokens',
  NESSIE_MODEL_NAME: 'model.modelName',
  NESSIE_MODEL_SERVICE_ID: 'model.serviceId',
  NESSIE_MODEL_BACKENDS: 'model.backends',
  NESSIE_MODEL_TEMPERATURE: 'model.temperature',
  NESSIE_LEDGER_IMAGE_PURPOSE_API_ID: 'model.imagePurposeApiId',
  NESSIE_EMBEDDING_PROVIDER: 'embedding.provider',
  NESSIE_EMBEDDING_API_KEY: 'embedding.apiKey',
  NESSIE_EMBEDDING_BASE_URL: 'embedding.baseUrl',
  NESSIE_EMBEDDING_MODEL: 'embedding.modelName',
  NESSIE_EMBEDDING_SERVICE_ID: 'embedding.serviceId',
  NESSIE_API_HOST: 'api.host',
  NESSIE_API_PORT: 'api.port',
  NESSIE_API_TRUSTED_PROXY_HOPS: 'api.trustedProxyHops',
  NESSIE_RATE_LIMIT_LOGIN_IP_MAX: 'api.rateLimit.loginIp.max',
  NESSIE_RATE_LIMIT_LOGIN_IP_WINDOW_MS: 'api.rateLimit.loginIp.windowMs',
  NESSIE_RATE_LIMIT_LOGIN_ACCOUNT_MAX: 'api.rateLimit.loginAccount.max',
  NESSIE_RATE_LIMIT_LOGIN_ACCOUNT_WINDOW_MS: 'api.rateLimit.loginAccount.windowMs',
  NESSIE_RATE_LIMIT_REFRESH_IP_MAX: 'api.rateLimit.refreshIp.max',
  NESSIE_RATE_LIMIT_REFRESH_IP_WINDOW_MS: 'api.rateLimit.refreshIp.windowMs',
  NESSIE_RATE_LIMIT_REFRESH_ACCOUNT_MAX: 'api.rateLimit.refreshAccount.max',
  NESSIE_RATE_LIMIT_REFRESH_ACCOUNT_WINDOW_MS: 'api.rateLimit.refreshAccount.windowMs',
  NESSIE_RATE_LIMIT_BOOTSTRAP_IP_MAX: 'api.rateLimit.bootstrapIp.max',
  NESSIE_RATE_LIMIT_BOOTSTRAP_IP_WINDOW_MS: 'api.rateLimit.bootstrapIp.windowMs',
  NESSIE_RATE_LIMIT_MCP_OAUTH_IP_MAX: 'api.rateLimit.mcpOauthIp.max',
  NESSIE_RATE_LIMIT_MCP_OAUTH_IP_WINDOW_MS: 'api.rateLimit.mcpOauthIp.windowMs',
  NESSIE_RATE_LIMIT_MCP_SECRET_WRITE_IP_MAX: 'api.rateLimit.mcpSecretWriteIp.max',
  NESSIE_RATE_LIMIT_MCP_SECRET_WRITE_IP_WINDOW_MS: 'api.rateLimit.mcpSecretWriteIp.windowMs',
  NESSIE_RATE_LIMIT_MCP_SECRET_WRITE_ACCOUNT_MAX: 'api.rateLimit.mcpSecretWriteAccount.max',
  NESSIE_RATE_LIMIT_MCP_SECRET_WRITE_ACCOUNT_WINDOW_MS: 'api.rateLimit.mcpSecretWriteAccount.windowMs',
  NESSIE_RATE_LIMIT_EXECUTOR_DAEMON_IP_MAX: 'api.rateLimit.executorDaemonIp.max',
  NESSIE_RATE_LIMIT_EXECUTOR_DAEMON_IP_WINDOW_MS: 'api.rateLimit.executorDaemonIp.windowMs',
  NESSIE_RATE_LIMIT_STEP_UP_IP_MAX: 'api.rateLimit.stepUpIp.max',
  NESSIE_RATE_LIMIT_STEP_UP_IP_WINDOW_MS: 'api.rateLimit.stepUpIp.windowMs',
  NESSIE_RATE_LIMIT_STEP_UP_ACCOUNT_MAX: 'api.rateLimit.stepUpAccount.max',
  NESSIE_RATE_LIMIT_STEP_UP_ACCOUNT_WINDOW_MS: 'api.rateLimit.stepUpAccount.windowMs',
  NESSIE_RATE_LIMIT_SSO_AUTHORIZE_IP_MAX: 'api.rateLimit.ssoAuthorizeIp.max',
  NESSIE_RATE_LIMIT_SSO_AUTHORIZE_IP_WINDOW_MS: 'api.rateLimit.ssoAuthorizeIp.windowMs',
  NESSIE_RATE_LIMIT_THREAD_MESSAGE_IP_MAX: 'api.rateLimit.threadMessageIp.max',
  NESSIE_RATE_LIMIT_THREAD_MESSAGE_IP_WINDOW_MS: 'api.rateLimit.threadMessageIp.windowMs',
  NESSIE_RATE_LIMIT_MAILBOX_DISCOVER_IP_MAX: 'api.rateLimit.mailboxDiscoverIp.max',
  NESSIE_RATE_LIMIT_MAILBOX_DISCOVER_IP_WINDOW_MS: 'api.rateLimit.mailboxDiscoverIp.windowMs',
  NESSIE_RATE_LIMIT_AGENT_WRITE_IP_MAX: 'api.rateLimit.agentWriteIp.max',
  NESSIE_RATE_LIMIT_AGENT_WRITE_IP_WINDOW_MS: 'api.rateLimit.agentWriteIp.windowMs',
  NESSIE_RATE_LIMIT_AUTH_ME_IP_MAX: 'api.rateLimit.authMeIp.max',
  NESSIE_RATE_LIMIT_AUTH_ME_IP_WINDOW_MS: 'api.rateLimit.authMeIp.windowMs',
  NESSIE_RATE_LIMIT_TRIGGER_WEBHOOK_IP_MAX: 'api.rateLimit.triggerWebhookIp.max',
  NESSIE_RATE_LIMIT_TRIGGER_WEBHOOK_IP_WINDOW_MS: 'api.rateLimit.triggerWebhookIp.windowMs',
  NESSIE_RATE_LIMIT_COMMS_WEBHOOK_IP_MAX: 'api.rateLimit.commsWebhookIp.max',
  NESSIE_RATE_LIMIT_COMMS_WEBHOOK_IP_WINDOW_MS: 'api.rateLimit.commsWebhookIp.windowMs',
  NESSIE_RATE_LIMIT_BOARD_SOURCE_WEBHOOK_IP_MAX: 'api.rateLimit.boardSourceWebhookIp.max',
  NESSIE_RATE_LIMIT_BOARD_SOURCE_WEBHOOK_IP_WINDOW_MS: 'api.rateLimit.boardSourceWebhookIp.windowMs',
  NESSIE_RATE_LIMIT_AGENT_EMAIL_INBOUND_IP_MAX: 'api.rateLimit.agentEmailInboundIp.max',
  NESSIE_RATE_LIMIT_AGENT_EMAIL_INBOUND_IP_WINDOW_MS: 'api.rateLimit.agentEmailInboundIp.windowMs',
  NESSIE_RATE_LIMIT_EXECUTOR_DAEMON_SESSION_IP_MAX: 'api.rateLimit.executorDaemonSessionIp.max',
  NESSIE_RATE_LIMIT_EXECUTOR_DAEMON_SESSION_IP_WINDOW_MS: 'api.rateLimit.executorDaemonSessionIp.windowMs',
  NESSIE_RATE_LIMIT_PUBLIC_ROUTE_IP_MAX: 'api.rateLimit.publicRouteIp.max',
  NESSIE_RATE_LIMIT_PUBLIC_ROUTE_IP_WINDOW_MS: 'api.rateLimit.publicRouteIp.windowMs',
  NESSIE_RATE_LIMIT_SUBSCRIPTION_DEVICE_IP_MAX: 'api.rateLimit.subscriptionDeviceIp.max',
  NESSIE_RATE_LIMIT_SUBSCRIPTION_DEVICE_IP_WINDOW_MS: 'api.rateLimit.subscriptionDeviceIp.windowMs',
  NESSIE_RATE_LIMIT_SUBSCRIPTION_DEVICE_ACCOUNT_MAX: 'api.rateLimit.subscriptionDeviceAccount.max',
  NESSIE_RATE_LIMIT_SUBSCRIPTION_DEVICE_ACCOUNT_WINDOW_MS: 'api.rateLimit.subscriptionDeviceAccount.windowMs',
  NESSIE_API_PUBLIC_URL: 'api.publicUrl',
  NESSIE_GITHUB_TOKEN: 'github.token',
  NESSIE_GITHUB_OWNER: 'github.owner',
  NESSIE_GITHUB_REPO: 'github.repo',
  NESSIE_WEBPUSH_PUBLIC_KEY: 'webPush.publicKey',
  NESSIE_WEBPUSH_PRIVATE_KEY: 'webPush.privateKey',
  NESSIE_WEBPUSH_SUBJECT: 'webPush.subject',
  NESSIE_EMAIL_SES_REGION: 'email.sesRegion',
  NESSIE_EMAIL_SES_ACCESS_KEY_ID: 'email.accessKeyId',
  NESSIE_EMAIL_SES_SECRET_ACCESS_KEY: 'email.secretAccessKey',
  NESSIE_EMAIL_DOMAIN: 'email.domain',
  NESSIE_EMAIL_INBOUND_S3_BUCKET: 'email.inboundBucket',
  NESSIE_EMAIL_INBOUND_S3_PREFIX: 'email.inboundPrefix',
  NESSIE_EMAIL_SNS_TOPIC_ARN: 'email.snsTopicArn',
  NESSIE_EMAIL_CONFIGURATION_SET: 'email.configurationSet',
  NESSIE_EMAIL_INBOUND_RETENTION_DAYS: 'email.inboundRetentionDays',
  NESSIE_EMAIL_CUSTOM_DOMAINS: 'email.customDomains',
  NESSIE_AGENT_MAIL_MAX_SENDS_PER_HOUR: 'email.maxSendsPerHour',
  NESSIE_AUTOMATIC_MEMBERSHIP_ENABLED: 'automaticMembership.enabled',
  NESSIE_AGENT_MAIL_MAX_INBOUND_BYTES: 'email.maxInboundBytes',
} as const

export type LoadConfigOptions = {
  argv?: string[]
  configPath?: string
  cwd?: string
  env?: NodeJS.ProcessEnv
}

type JsonObject = Record<string, unknown>

// Local Postgres default. Derives the role from the environment (same precedence
// libpq/psql use) instead of hard-coding a single developer's username, and
// targets the canonical local database `nessie`. Overridden by DATABASE_URL /
// NESSIE_DB_URL whenever they are set.
const localPostgresUser = (): string =>
  process.env['PGUSER']
  ?? process.env['USER']
  ?? process.env['LOGNAME']
  ?? process.env['USERNAME']
  ?? 'postgres'

const DEFAULT_LOCAL_DATABASE_URL =
  `postgresql://${encodeURIComponent(localPostgresUser())}`
  + `@${process.env['PGHOST'] ?? 'localhost'}:${process.env['PGPORT'] ?? '5432'}/nessie`

const DEFAULT_CONFIG: NessieConfig = {
  mode: 'local',
  shutdownTimeoutMs: 25_000,
  auth: {
    providers: [],
    autoRedirectToSso: false,
    tokenTtlSeconds: 30 * 60,
    refreshTokenTtlSeconds: 30 * 24 * 60 * 60,
  },
  database: {
    url: DEFAULT_LOCAL_DATABASE_URL,
    poolMin: 2,
    poolMax: 10,
  },
  storage: {
    provider: 'filesystem',
    localPath: '.nessie/storage',
    maxUploadBytes: 5 * 1024 * 1024 * 1024,
  },
  queue: {
    provider: 'local',
  },
  model: {
    provider: 'openai',
    maxTokens: 2048,
    temperature: 0.2,
    backends: [],
  },
  embedding: {},
  api: {
    host: '0.0.0.0',
    port: 5454,
    trustedProxyHops: 0,
    rateLimit: {
      loginIp: { max: 10, windowMs: 10 * 60_000 },
      loginAccount: { max: 5, windowMs: 10 * 60_000 },
      refreshIp: { max: 30, windowMs: 10 * 60_000 },
      refreshAccount: { max: 20, windowMs: 10 * 60_000 },
      bootstrapIp: { max: 10, windowMs: 10 * 60_000 },
      mcpOauthIp: { max: 20, windowMs: 10 * 60_000 },
      mcpSecretWriteIp: { max: 20, windowMs: 10 * 60_000 },
      mcpSecretWriteAccount: { max: 10, windowMs: 10 * 60_000 },
      executorDaemonIp: { max: 60, windowMs: 10 * 60_000 },
      stepUpIp: { max: 10, windowMs: 10 * 60_000 },
      stepUpAccount: { max: 5, windowMs: 10 * 60_000 },
      subscriptionDeviceIp: { max: 240, windowMs: 10 * 60_000 },
      subscriptionDeviceAccount: { max: 120, windowMs: 10 * 60_000 },
      ssoAuthorizeIp: { max: 20, windowMs: 10 * 60_000 },
      threadMessageIp: { max: 60, windowMs: 60_000 },
      mailboxDiscoverIp: { max: 30, windowMs: 60_000 },
      agentWriteIp: { max: 60, windowMs: 60_000 },
      authMeIp: { max: 600, windowMs: 60_000 },
      triggerWebhookIp: { max: 120, windowMs: 60_000 },
      commsWebhookIp: { max: 600, windowMs: 60_000 },
      boardSourceWebhookIp: { max: 600, windowMs: 60_000 },
      agentEmailInboundIp: { max: 600, windowMs: 60_000 },
      executorDaemonSessionIp: { max: 6_000, windowMs: 60_000 },
      publicRouteIp: { max: 1_200, windowMs: 60_000 },
    },
  },
  github: {
    owner: 'UnlikeOtherAI',
    repo: 'Nessie',
  },
  webPush: {},
  email: {
    inboundPrefix: '',
    inboundRetentionDays: 30,
    customDomains: false,
    maxSendsPerHour: 30,
    maxInboundBytes: 25 * 1024 * 1024,
  },
  automaticMembership: {
    enabled: false,
  },
}

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const coerceScalar = (value: string): boolean | number | string => {
  if (value === 'true') {
    return true
  }

  if (value === 'false') {
    return false
  }

  if (value !== '' && !Number.isNaN(Number(value))) {
    return Number(value)
  }

  return value
}

const setByPath = (target: JsonObject, path: string, value: unknown): void => {
  const segments = path.split('.')
  let current = target

  for (const segment of segments.slice(0, -1)) {
    const existing = current[segment]
    if (!isJsonObject(existing)) {
      current[segment] = {}
    }
    current = current[segment] as JsonObject
  }

  const lastSegment = segments.at(-1)
  if (!lastSegment) {
    return
  }

  current[lastSegment] = value
}

const mergeObjects = (base: JsonObject, override: JsonObject): JsonObject => {
  const result: JsonObject = { ...base }

  for (const [key, value] of Object.entries(override)) {
    const existing = result[key]

    if (isJsonObject(existing) && isJsonObject(value)) {
      result[key] = mergeObjects(existing, value)
      continue
    }

    result[key] = value
  }

  return result
}

const loadConfigFile = (cwd: string, configPath?: string): JsonObject => {
  const candidate = resolve(cwd, configPath ?? 'nessie.config.json')
  if (!existsSync(candidate)) {
    return {}
  }

  const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as unknown
  if (!isJsonObject(parsed)) {
    throw new Error(`Config file must contain a JSON object: ${candidate}`)
  }

  return parsed
}

const loadEnvOverrides = (env: NodeJS.ProcessEnv): JsonObject => {
  const overrides: JsonObject = {}

  for (const [envKey, configPath] of Object.entries(ConfigEnvMap)) {
    const value = env[envKey]
    // An explicitly emptied variable (`DATABASE_URL= pnpm test` unsets the
    // database for a run) means "no override", not the empty string — only
    // `undefined` marks a variable unset, and an empty string would fail the
    // schema's `min(1)` checks and crash every process that loads config.
    if (value !== undefined && value !== '') {
      setByPath(overrides, configPath, coerceScalar(value))
    }
  }

  if (
    (env.NESSIE_DB_URL === undefined || env.NESSIE_DB_URL === '') &&
    env.DATABASE_URL !== undefined &&
    env.DATABASE_URL !== ''
  ) {
    setByPath(overrides, 'database.url', env.DATABASE_URL)
  }

  // Container runtimes that pick the port for you (Cloud Run, Heroku, Fly)
  // inject `PORT` and nothing else. Accept it as a *lower-precedence* fallback:
  // an explicit `NESSIE_API_PORT` is a deliberate operator choice and still
  // wins, so pinning the production container's internal port keeps working
  // even where the platform also sets `PORT`.
  if (
    (env.NESSIE_API_PORT === undefined || env.NESSIE_API_PORT === '') &&
    env.PORT !== undefined &&
    env.PORT !== ''
  ) {
    setByPath(overrides, 'api.port', coerceScalar(env.PORT))
  }

  const firstNonEmpty = (...values: Array<string | undefined>): string | undefined =>
    values.find((value) => value !== undefined && value !== '')

  const modelProvider =
    firstNonEmpty(env.NESSIE_MODEL_PROVIDER, env.LLM_PROVIDER) ??
    (env.KIMI_API_KEY !== undefined
      ? 'kimi'
      : env.DEEPSEEK_API_KEY !== undefined
          ? 'deepseek'
        : env.OPENAI_CHAT_API_KEY !== undefined || env.OPENAI_API_KEY !== undefined
          ? 'openai'
          : undefined)

  if (modelProvider !== undefined) {
    setByPath(overrides, 'model.provider', modelProvider)
  }

  const modelName = firstNonEmpty(env.NESSIE_MODEL_NAME)
  if (modelName !== undefined) {
    setByPath(overrides, 'model.modelName', modelName)
  }

  const modelApiKey =
    firstNonEmpty(env.NESSIE_MODEL_API_KEY) ??
    (modelProvider === 'kimi'
      ? env.KIMI_API_KEY
      : modelProvider === 'deepseek'
          ? env.DEEPSEEK_API_KEY
        : modelProvider === 'openai'
          ? env.OPENAI_CHAT_API_KEY ?? env.OPENAI_API_KEY
          : undefined)

  if (modelApiKey !== undefined) {
    setByPath(overrides, 'model.apiKey', modelApiKey)
  }

  // Parse comma-separated NESSIE_MODEL_BACKENDS into a string[] for model.backends
  if (env.NESSIE_MODEL_BACKENDS !== undefined) {
    const raw = env.NESSIE_MODEL_BACKENDS
    const parsed = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    setByPath(overrides, 'model.backends', parsed)
  }

  return overrides
}

const loadCliOverrides = (argv: string[]): JsonObject => {
  const overrides: JsonObject = {}

  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      continue
    }

    const equalsIndex = arg.indexOf('=')
    if (equalsIndex <= 2) {
      continue
    }

    const path = arg.slice(2, equalsIndex)
    const value = arg.slice(equalsIndex + 1)
    setByPath(overrides, path, coerceScalar(value))
  }

  return overrides
}

export const deriveRuntimeCapabilities = (config: NessieConfig): RuntimeCapabilities =>
  RuntimeCapabilitiesSchema.parse({
    hasObjectStorage: config.storage.provider !== 'filesystem',
    hasExternalAuth: config.auth.providers.some(
      (provider) => provider.enabled && provider.type !== 'local-bootstrap',
    ),
    hasPubSub: config.queue.provider === 'pubsub',
    hasModelProvider: Boolean(config.model.apiKey),
  })

export const loadConfig = (options: LoadConfigOptions = {}): NessieConfig => {
  const cwd = options.cwd ?? process.cwd()
  const env = options.env ?? process.env
  const argv = options.argv ?? process.argv.slice(2)
  const configPath = options.configPath ?? env.NESSIE_CONFIG_PATH

  const merged = mergeObjects(
    mergeObjects(
      mergeObjects(DEFAULT_CONFIG as JsonObject, loadConfigFile(cwd, configPath)),
      loadEnvOverrides(env),
    ),
    loadCliOverrides(argv),
  )

  const config = NessieConfigSchema.parse(merged)

  // Invariant 7 (docs/standards/horizontal-scaling.md). This is the one
  // single-host capability that is configuration, and both the API and the
  // worker load config before they do anything else, so this is the earliest
  // point at which either can refuse it.
  if (config.storage.provider === 'filesystem') {
    assertLocalOnlyCapability(config.mode, FILESYSTEM_STORAGE)
  }

  return config
}

let gateMode: NessieMode | undefined

/**
 * The mode the single-host gates in `local-only.ts` ask about, resolved once
 * per process.
 *
 * `loadConfig` is deliberately not memoised — it re-reads `nessie.config.json`
 * off disk, walks the whole env map and re-runs the entire `NessieConfigSchema`
 * parse on every call — and the gates sit on the run's hot path: one call per
 * builtin tool dispatch, one per execution-environment probe and provision.
 * They must not pay that each time. Caching also makes the answer stable: a
 * process cannot decide halfway through a run that it is a different kind of
 * deployment than it was a moment earlier.
 *
 * The mode is fixed for the life of a container — it comes from the environment
 * the container was started with — so there is nothing to invalidate.
 */
export const localOnlyGateMode = (): NessieMode => (gateMode ??= loadConfig().mode)

import { z } from 'zod'
import { EncryptionConfigSchema } from './encryption-key-ring.js'

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

// One value on purpose. The Pub/Sub adapter (`packages/runtime/src/pubsub-queue.ts`)
// and the worker branch that fell back from it are deleted, and so is the
// Pub/Sub terraform module; Postgres is the queue by decision
// (docs/standards/horizontal-scaling/overview.md). Keeping `'pubsub'` in the enum let a
// deployment be configured for a provider that no longer exists and then boot
// silently on Postgres anyway.
//
// The error map is the point of the block. A bare `z.enum(['local'])` rejects
// `NESSIE_QUEUE_PROVIDER=pubsub` with zod's generic "Invalid enum value.
// Expected 'local', received 'pubsub'", which tells an operator staring at a
// crashed boot nothing about *why* their working configuration stopped being
// legal. Naming the retirement in the message is what turns the rejection into
// an answer.
export const QueueProviderSchema = z.enum(['local'], {
  errorMap: (issue, ctx) => {
    if (issue.code !== z.ZodIssueCode.invalid_enum_value) {
      return { message: ctx.defaultError }
    }

    return {
      message:
        `Unsupported queue provider '${String(issue.received)}'. Postgres is the queue; `
        + "the 'pubsub' provider was retired and its adapter deleted "
        + '(docs/standards/horizontal-scaling/overview.md). Set NESSIE_QUEUE_PROVIDER=local or remove it.',
    }
  },
})
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
  encryption: EncryptionConfigSchema.default({ keys: {} }),
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
    // The address of the object store **as a client sees it**, and the single
    // switch that turns signed-URL downloads on (horizontal-scaling invariant 7;
    // plan row 5.7 / audit 6.4). Unset — the default everywhere — means the API
    // proxies every download, exactly as it always has.
    //
    // It is deliberately separate from `endpoint`, which is the address the API
    // and the worker reach the store on, and deliberately not derived from it:
    // production MinIO sits on a private Docker network as `nessie-minio:9000`,
    // and a signed URL naming that host is useless to a browser. Setting this
    // asserts two things about the address that nothing here can check —
    // that clients can reach it, and that it answers with an
    // `Access-Control-Allow-Origin` covering the admin origin, because the admin
    // follows the redirect from `fetch()`. SigV4 signs the Host header, so the
    // signature is minted against this address, not `endpoint`.
    publicEndpoint: z.string().min(1).optional(),
    // Upload ceiling shared by API multipart limits and the FileService quota
    // pre-check. Defaults to 5 GiB.
    maxUploadBytes: z.number().int().positive().default(5 * 1024 * 1024 * 1024),
    // The size at which a download stops being proxied and becomes a redirect
    // to a signed URL, when `publicEndpoint` makes that possible at all.
    // Defaults to 8 MiB — see SIGNED_DOWNLOAD_MIN_BYTES in @nessie/runtime for
    // why that number and not another.
    signedDownloadMinBytes: z.number().int().positive().default(8 * 1024 * 1024),
  }),
  queue: z.object({
    provider: QueueProviderSchema,
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

// No `hasRedis`, and no `hasPubSub`: `redis.enabled` had no environment mapping
// and nothing ever read `config.redis`, and `hasPubSub` could only ever be true
// for a queue provider that no longer exists. Postgres is the queue and the
// realtime bus by decision (docs/standards/horizontal-scaling/overview.md), so there is
// nothing for either of them to describe.
export const RuntimeCapabilitiesSchema = z.object({
  hasObjectStorage: z.boolean(),
  hasExternalAuth: z.boolean(),
  hasModelProvider: z.boolean(),
})
export type RuntimeCapabilities = z.infer<typeof RuntimeCapabilitiesSchema>


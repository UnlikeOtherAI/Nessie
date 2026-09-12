import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  type NessieConfig,
  NessieConfigSchema,
  type NessieMode,
  type RuntimeCapabilities,
  RuntimeCapabilitiesSchema,
} from './config-schema.js'
import { assertLocalOnlyCapability, FILESYSTEM_STORAGE } from './local-only.js'
import { parseEncryptionKeyRingEnv } from './encryption-key-ring.js'

export const ConfigEnvMap = {
  NESSIE_MODE: 'mode',
  NESSIE_AUTH_AUTO_REDIRECT: 'auth.autoRedirectToSso',
  NESSIE_AUTH_SECRET: 'auth.secret',
  NESSIE_ENCRYPTION_ACTIVE_KEY_VERSION: 'encryption.activeKeyVersion',
  NESSIE_ENCRYPTION_LEGACY_KEY: 'encryption.legacyKey',
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
  NESSIE_STORAGE_PUBLIC_ENDPOINT: 'storage.publicEndpoint',
  NESSIE_MAX_UPLOAD_BYTES: 'storage.maxUploadBytes',
  NESSIE_STORAGE_SIGNED_DOWNLOAD_MIN_BYTES: 'storage.signedDownloadMinBytes',
  NESSIE_QUEUE_PROVIDER: 'queue.provider',
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
  encryption: {
    keys: {},
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
    signedDownloadMinBytes: 8 * 1024 * 1024,
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

  // A JSON object keeps a versioned key-ring usable in ordinary secret
  // injectors without inventing an unbounded set of environment variable
  // names. It is parsed here, before the schema validates key versions and
  // root lengths. The value is never logged or reflected in diagnostics.
  const keyRing = parseEncryptionKeyRingEnv(env.NESSIE_ENCRYPTION_KEY_RING)
  if (keyRing) setByPath(overrides, 'encryption.keys', keyRing)

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

  // Invariant 7 (docs/standards/horizontal-scaling/overview.md). This is the one
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

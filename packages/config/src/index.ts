import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'

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

export const ModelProviderSchema = z.enum(['openai', 'minimax'])
export type ModelProvider = z.infer<typeof ModelProviderSchema>

export const ModelConfigSchema = z.object({
  provider: ModelProviderSchema,
  apiKey: z.string().min(1).optional(),
  maxTokens: z.number().int().positive().default(2048),
  modelName: z.string().min(1).optional(),
  temperature: z.number().min(0).max(2).default(0.2),
})
export type ModelConfig = z.infer<typeof ModelConfigSchema>

export const NessieConfigSchema = z.object({
  mode: NessieModeSchema,
  auth: z.object({
    providers: z.array(AuthProviderConfigSchema),
    autoRedirectToSso: z.boolean().default(false),
    secret: z.string().min(1).optional(),
    tokenTtlSeconds: z.number().int().positive().default(24 * 60 * 60),
  }),
  database: z.object({
    url: z.string().min(1),
    poolMin: z.number().int().nonnegative().default(2),
    poolMax: z.number().int().positive().default(10),
  }),
  redis: z
    .object({
      url: z.string().min(1),
      enabled: z.boolean().default(false),
    })
    .optional(),
  storage: z.object({
    provider: StorageProviderSchema,
    bucket: z.string().min(1).optional(),
    localPath: z.string().min(1).optional(),
  }),
  queue: z.object({
    provider: QueueProviderSchema,
    projectId: z.string().min(1).optional(),
  }),
  model: ModelConfigSchema,
  api: z.object({
    host: z.string().min(1).default('0.0.0.0'),
    port: z.number().int().positive().default(5554),
  }),
})
export type NessieConfig = z.infer<typeof NessieConfigSchema>

export const RuntimeCapabilitiesSchema = z.object({
  hasRedis: z.boolean(),
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
  NESSIE_DB_URL: 'database.url',
  NESSIE_REDIS_URL: 'redis.url',
  NESSIE_STORAGE_PROVIDER: 'storage.provider',
  NESSIE_STORAGE_BUCKET: 'storage.bucket',
  NESSIE_STORAGE_LOCAL_PATH: 'storage.localPath',
  NESSIE_QUEUE_PROVIDER: 'queue.provider',
  NESSIE_QUEUE_PROJECT_ID: 'queue.projectId',
  NESSIE_MODEL_PROVIDER: 'model.provider',
  NESSIE_MODEL_API_KEY: 'model.apiKey',
  NESSIE_MODEL_MAX_TOKENS: 'model.maxTokens',
  NESSIE_MODEL_NAME: 'model.modelName',
  NESSIE_MODEL_TEMPERATURE: 'model.temperature',
  NESSIE_API_HOST: 'api.host',
  NESSIE_API_PORT: 'api.port',
} as const

export type LoadConfigOptions = {
  argv?: string[]
  configPath?: string
  cwd?: string
  env?: NodeJS.ProcessEnv
}

type JsonObject = Record<string, unknown>

const DEFAULT_CONFIG: NessieConfig = {
  mode: 'local',
  auth: {
    providers: [],
    autoRedirectToSso: false,
    tokenTtlSeconds: 24 * 60 * 60,
  },
  database: {
    url: 'postgresql://dictator@localhost:5432/nessie',
    poolMin: 2,
    poolMax: 10,
  },
  storage: {
    provider: 'filesystem',
    localPath: '.nessie/storage',
  },
  queue: {
    provider: 'local',
  },
  model: {
    provider: 'openai',
    maxTokens: 2048,
    temperature: 0.2,
  },
  api: {
    host: '0.0.0.0',
    port: 5554,
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
    if (value !== undefined) {
      setByPath(overrides, configPath, coerceScalar(value))
    }
  }

  if (env.NESSIE_DB_URL === undefined && env.DATABASE_URL !== undefined) {
    setByPath(overrides, 'database.url', env.DATABASE_URL)
  }

  const modelProvider =
    env.NESSIE_MODEL_PROVIDER ??
    env.LLM_PROVIDER ??
    (env.MINIMAX_API_KEY !== undefined
      ? 'minimax'
      : env.OPENAI_CHAT_API_KEY !== undefined || env.OPENAI_API_KEY !== undefined
        ? 'openai'
        : undefined)

  if (modelProvider !== undefined) {
    setByPath(overrides, 'model.provider', modelProvider)
  }

  if (env.NESSIE_MODEL_NAME !== undefined) {
    setByPath(overrides, 'model.modelName', env.NESSIE_MODEL_NAME)
  }

  const modelApiKey =
    env.NESSIE_MODEL_API_KEY ??
    (modelProvider === 'minimax'
      ? env.MINIMAX_API_KEY
      : modelProvider === 'openai'
        ? env.OPENAI_CHAT_API_KEY ?? env.OPENAI_API_KEY
        : undefined)

  if (modelApiKey !== undefined) {
    setByPath(overrides, 'model.apiKey', modelApiKey)
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
    hasRedis: Boolean(config.redis?.enabled && config.redis.url),
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

  return NessieConfigSchema.parse(merged)
}

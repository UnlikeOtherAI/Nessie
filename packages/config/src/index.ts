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

export const NessieConfigSchema = z.object({
  mode: NessieModeSchema,
  auth: z.object({
    providers: z.array(AuthProviderConfigSchema),
    autoRedirectToSso: z.boolean().default(false),
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
})
export type NessieConfig = z.infer<typeof NessieConfigSchema>

export const RuntimeCapabilitiesSchema = z.object({
  hasRedis: z.boolean(),
  hasObjectStorage: z.boolean(),
  hasExternalAuth: z.boolean(),
  hasPubSub: z.boolean(),
})
export type RuntimeCapabilities = z.infer<typeof RuntimeCapabilitiesSchema>

export const ConfigEnvMap = {
  NESSIE_MODE: 'mode',
  NESSIE_AUTH_AUTO_REDIRECT: 'auth.autoRedirectToSso',
  NESSIE_DB_URL: 'database.url',
  NESSIE_REDIS_URL: 'redis.url',
  NESSIE_STORAGE_PROVIDER: 'storage.provider',
  NESSIE_STORAGE_BUCKET: 'storage.bucket',
  NESSIE_STORAGE_LOCAL_PATH: 'storage.localPath',
  NESSIE_QUEUE_PROVIDER: 'queue.provider',
  NESSIE_QUEUE_PROJECT_ID: 'queue.projectId',
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
  },
  database: {
    url: 'postgresql://localhost:5432/nessie',
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
  })

export const loadConfig = (options: LoadConfigOptions = {}): NessieConfig => {
  const cwd = options.cwd ?? process.cwd()
  const env = options.env ?? process.env
  const argv = options.argv ?? process.argv.slice(2)

  const merged = mergeObjects(
    mergeObjects(
      mergeObjects(DEFAULT_CONFIG as JsonObject, loadConfigFile(cwd, options.configPath)),
      loadEnvOverrides(env),
    ),
    loadCliOverrides(argv),
  )

  return NessieConfigSchema.parse(merged)
}

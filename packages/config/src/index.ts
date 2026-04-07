import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

export const authProviderConfigSchema = z.object({
  providerId: z.string().min(1),
  type: z.enum(['oidc', 'saml', 'uoa', 'local-bootstrap', 'custom']),
  label: z.string().min(1),
  enabled: z.boolean().default(true),
  autoRedirect: z.boolean().default(false),
  issuerUrl: z.string().url().optional(),
  clientId: z.string().min(1).optional(),
  scopes: z.array(z.string().min(1)).default([]),
  mappingRules: z.record(z.string(), z.string()).optional(),
})

export const nessieConfigSchema = z.object({
  mode: z.enum(['hosted', 'selfHosted', 'local']),
  auth: z.object({
    providers: z.array(authProviderConfigSchema),
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
    provider: z.enum(['filesystem', 'gcs', 's3']),
    bucket: z.string().min(1).optional(),
    localPath: z.string().min(1).optional(),
  }),
  queue: z.object({
    provider: z.enum(['pubsub', 'local']),
    projectId: z.string().min(1).optional(),
  }),
})

export type AuthProviderConfig = z.infer<typeof authProviderConfigSchema>
export type NessieConfig = z.infer<typeof nessieConfigSchema>

export type RuntimeCapabilities = {
  hasRedis: boolean
  hasObjectStorage: boolean
  hasExternalAuth: boolean
  hasPubSub: boolean
}

const defaultConfig: NessieConfig = {
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

export const configEnvMap = {
  NESSIE_MODE: 'mode',
  NESSIE_AUTH_AUTO_REDIRECT: 'auth.autoRedirectToSso',
  NESSIE_DB_URL: 'database.url',
  NESSIE_REDIS_URL: 'redis.url',
  NESSIE_STORAGE_PROVIDER: 'storage.provider',
} as const

type JsonObject = Record<string, unknown>

type LoadConfigOptions = {
  cwd?: string
  configPath?: string
  env?: NodeJS.ProcessEnv
  argv?: string[]
}

const isPlainObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const deepMerge = (base: JsonObject, override: JsonObject): JsonObject => {
  const result: JsonObject = { ...base }

  for (const [key, value] of Object.entries(override)) {
    const existing = result[key]

    if (isPlainObject(existing) && isPlainObject(value)) {
      result[key] = deepMerge(existing, value)
      continue
    }

    result[key] = value
  }

  return result
}

const setByPath = (target: JsonObject, path: string, rawValue: unknown) => {
  const segments = path.split('.')
  let current = target

  for (const segment of segments.slice(0, -1)) {
    const next = current[segment]
    if (!isPlainObject(next)) {
      current[segment] = {}
    }
    current = current[segment] as JsonObject
  }

  current[segments.at(-1) as string] = rawValue
}

const coercePrimitive = (value: string): string | boolean | number => {
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

const loadConfigFile = (cwd: string, configPath?: string): JsonObject => {
  const candidate = configPath ? join(cwd, configPath) : join(cwd, 'nessie.config.json')

  if (!existsSync(candidate)) {
    return {}
  }

  const raw = readFileSync(candidate, 'utf8')
  const parsed = JSON.parse(raw) as unknown

  if (!isPlainObject(parsed)) {
    throw new Error(`Config file must contain a JSON object: ${candidate}`)
  }

  return parsed
}

const loadEnvConfig = (env: NodeJS.ProcessEnv): JsonObject => {
  const mapped: JsonObject = {}

  for (const [envKey, configPath] of Object.entries(configEnvMap)) {
    const value = env[envKey]
    if (value !== undefined) {
      setByPath(mapped, configPath, coercePrimitive(value))
    }
  }

  return mapped
}

const loadCliConfig = (argv: string[]): JsonObject => {
  const mapped: JsonObject = {}

  for (const entry of argv) {
    if (!entry.startsWith('--')) {
      continue
    }

    const [flag, rawValue] = entry.slice(2).split('=')
    if (!flag || rawValue === undefined) {
      continue
    }

    setByPath(mapped, flag, coercePrimitive(rawValue))
  }

  return mapped
}

export const deriveRuntimeCapabilities = (config: NessieConfig): RuntimeCapabilities => ({
  hasRedis: Boolean(config.redis?.enabled && config.redis.url),
  hasObjectStorage: config.storage.provider !== 'filesystem',
  hasExternalAuth: config.auth.providers.some((provider) => provider.enabled && provider.type !== 'local-bootstrap'),
  hasPubSub: config.queue.provider === 'pubsub',
})

export const loadConfig = (options: LoadConfigOptions = {}) => {
  const cwd = options.cwd ?? process.cwd()
  const env = options.env ?? process.env
  const argv = options.argv ?? process.argv.slice(2)

  const merged = deepMerge(
    deepMerge(
      deepMerge(defaultConfig as JsonObject, loadConfigFile(cwd, options.configPath)),
      loadEnvConfig(env),
    ),
    loadCliConfig(argv),
  )

  const config = nessieConfigSchema.parse(merged)

  return {
    config,
    capabilities: deriveRuntimeCapabilities(config),
  }
}

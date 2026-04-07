import fs from 'node:fs'
import path from 'node:path'
import type { ZodIssue } from 'zod'
import type { NessieConfig, NessieConfigOverrides } from './schema.js'
import { NessieConfigSchema } from './schema.js'
import { NessieConfigError, formatConfigIssues } from './errors.js'
import type { RuntimeCapabilities } from './capabilities.js'
import { deriveRuntimeCapabilities } from './capabilities.js'

export type LoadConfigOptions = {
  cwd?: string
  env?: NodeJS.ProcessEnv
  argv?: string[]
  configFilePath?: string | null
}

export type LoadedNessieConfig = {
  config: NessieConfig
  capabilities: RuntimeCapabilities
  configFilePath: string | null
}

const DEFAULTS: NessieConfigOverrides = {
  mode: 'local',
  auth: {
    providers: [],
    autoRedirectToSso: false,
  },
  storage: {
    provider: 'filesystem',
  },
  queue: {
    provider: 'local',
  },
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deepMerge<T extends Record<string, unknown>>(base: T, override: Partial<T>): T {
  const result: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    const baseValue = result[key]
    if (isRecord(baseValue) && isRecord(value)) {
      result[key] = deepMerge(baseValue, value)
      continue
    }
    result[key] = value
  }
  return result as T
}

function parseJsonObject(contents: string, source: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(contents)
    if (!isRecord(parsed)) {
      throw new Error('config file must contain a JSON object')
    }
    return parsed
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new NessieConfigError(`Failed to parse config from ${source}`, [{ path: source, message }])
  }
}

function getBool(value: string): boolean | null {
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return null
}

function getNumber(value: string): number | null {
  if (value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function readCliValue(argv: string[], name: string): string | null {
  const prefix = `--${name}=`
  const matched = argv.find((arg) => arg.startsWith(prefix))
  if (matched) {
    return matched.slice(prefix.length)
  }
  const index = argv.findIndex((arg) => arg === `--${name}`)
  if (index >= 0 && index + 1 < argv.length && !argv[index + 1]!.startsWith('--')) {
    return argv[index + 1]!
  }
  return null
}

function parseEnvConfig(env: NodeJS.ProcessEnv): NessieConfigOverrides {
  const config: NessieConfigOverrides = {}

  if (env.NESSIE_MODE) {
    config.mode = env.NESSIE_MODE as NessieConfigOverrides['mode']
  }

  const autoRedirect = env.NESSIE_AUTH_AUTO_REDIRECT
  if (autoRedirect !== undefined) {
    const parsed = getBool(autoRedirect)
    if (parsed !== null) {
      config.auth = { ...(config.auth ?? {}), autoRedirectToSso: parsed }
    }
  }

  if (env.NESSIE_DB_URL) {
    config.database = { ...(config.database ?? {}), url: env.NESSIE_DB_URL }
  }

  const poolMin = env.NESSIE_DB_POOL_MIN
  if (poolMin !== undefined) {
    const parsed = getNumber(poolMin)
    if (parsed !== null) {
      config.database = { ...(config.database ?? {}), poolMin: parsed }
    }
  }

  const poolMax = env.NESSIE_DB_POOL_MAX
  if (poolMax !== undefined) {
    const parsed = getNumber(poolMax)
    if (parsed !== null) {
      config.database = { ...(config.database ?? {}), poolMax: parsed }
    }
  }

  if (env.NESSIE_REDIS_URL || env.NESSIE_REDIS_ENABLED !== undefined) {
    const redis: NonNullable<NessieConfigOverrides['redis']> = { ...(config.redis ?? {}) }
    if (env.NESSIE_REDIS_URL) redis.url = env.NESSIE_REDIS_URL
    if (env.NESSIE_REDIS_ENABLED !== undefined) {
      const parsed = getBool(env.NESSIE_REDIS_ENABLED)
      if (parsed !== null) redis.enabled = parsed
    }
    config.redis = redis
  }

  if (env.NESSIE_STORAGE_PROVIDER || env.NESSIE_STORAGE_BUCKET || env.NESSIE_STORAGE_LOCAL_PATH) {
    const storage: NonNullable<NessieConfigOverrides['storage']> = { ...(config.storage ?? {}) }
    if (env.NESSIE_STORAGE_PROVIDER) {
      storage.provider = env.NESSIE_STORAGE_PROVIDER as NonNullable<NessieConfigOverrides['storage']>['provider']
    }
    if (env.NESSIE_STORAGE_BUCKET) storage.bucket = env.NESSIE_STORAGE_BUCKET
    if (env.NESSIE_STORAGE_LOCAL_PATH) storage.localPath = env.NESSIE_STORAGE_LOCAL_PATH
    config.storage = storage
  }

  if (env.NESSIE_QUEUE_PROVIDER || env.NESSIE_QUEUE_PROJECT_ID) {
    const queue: NonNullable<NessieConfigOverrides['queue']> = { ...(config.queue ?? {}) }
    if (env.NESSIE_QUEUE_PROVIDER) {
      queue.provider = env.NESSIE_QUEUE_PROVIDER as NonNullable<NessieConfigOverrides['queue']>['provider']
    }
    if (env.NESSIE_QUEUE_PROJECT_ID) queue.projectId = env.NESSIE_QUEUE_PROJECT_ID
    config.queue = queue
  }

  return config
}

function parseCliConfig(argv: string[]): NessieConfigOverrides {
  const config: NessieConfigOverrides = {}
  const mode = readCliValue(argv, 'mode')
  if (mode) {
    config.mode = mode as NessieConfigOverrides['mode']
  }

  const autoRedirect = readCliValue(argv, 'auth-auto-redirect')
  if (autoRedirect !== null) {
    const parsed = getBool(autoRedirect)
    if (parsed !== null) {
      config.auth = { ...(config.auth ?? {}), autoRedirectToSso: parsed }
    }
  }

  const dbUrl = readCliValue(argv, 'db-url')
  if (dbUrl) {
    config.database = { ...(config.database ?? {}), url: dbUrl }
  }

  const dbPoolMin = readCliValue(argv, 'db-pool-min')
  if (dbPoolMin !== null) {
    const parsed = getNumber(dbPoolMin)
    if (parsed !== null) {
      config.database = { ...(config.database ?? {}), poolMin: parsed }
    }
  }

  const dbPoolMax = readCliValue(argv, 'db-pool-max')
  if (dbPoolMax !== null) {
    const parsed = getNumber(dbPoolMax)
    if (parsed !== null) {
      config.database = { ...(config.database ?? {}), poolMax: parsed }
    }
  }

  const redisUrl = readCliValue(argv, 'redis-url')
  const redisEnabled = readCliValue(argv, 'redis-enabled')
  if (redisUrl !== null || redisEnabled !== null) {
    const redis: NonNullable<NessieConfigOverrides['redis']> = { ...(config.redis ?? {}) }
    if (redisUrl) redis.url = redisUrl
    if (redisEnabled !== null) {
      const parsed = getBool(redisEnabled)
      if (parsed !== null) redis.enabled = parsed
    }
    config.redis = redis
  }

  const storageProvider = readCliValue(argv, 'storage-provider')
  const storageBucket = readCliValue(argv, 'storage-bucket')
  const storageLocalPath = readCliValue(argv, 'storage-local-path')
  if (storageProvider !== null || storageBucket !== null || storageLocalPath !== null) {
    const storage: NonNullable<NessieConfigOverrides['storage']> = { ...(config.storage ?? {}) }
    if (storageProvider) {
      storage.provider = storageProvider as NonNullable<NessieConfigOverrides['storage']>['provider']
    }
    if (storageBucket) storage.bucket = storageBucket
    if (storageLocalPath) storage.localPath = storageLocalPath
    config.storage = storage
  }

  const queueProvider = readCliValue(argv, 'queue-provider')
  const queueProjectId = readCliValue(argv, 'queue-project-id')
  if (queueProvider !== null || queueProjectId !== null) {
    const queue: NonNullable<NessieConfigOverrides['queue']> = { ...(config.queue ?? {}) }
    if (queueProvider) {
      queue.provider = queueProvider as NonNullable<NessieConfigOverrides['queue']>['provider']
    }
    if (queueProjectId) queue.projectId = queueProjectId
    config.queue = queue
  }

  return config
}

function collectIssues(issues: ZodIssue[]): { path: string; message: string }[] {
  return issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join('.') : 'config',
    message: issue.message,
  }))
}

function resolveConfigFilePath(cwd: string, explicitPath?: string | null): string | null {
  if (explicitPath === null) {
    return null
  }
  if (explicitPath) {
    return path.isAbsolute(explicitPath) ? explicitPath : path.resolve(cwd, explicitPath)
  }
  const candidate = path.resolve(cwd, 'nessie.config.json')
  return fs.existsSync(candidate) ? candidate : null
}

export function loadNessieConfig(options: LoadConfigOptions = {}): LoadedNessieConfig {
  const cwd = options.cwd ?? process.cwd()
  const env = options.env ?? process.env
  const argv = options.argv ?? process.argv.slice(2)
  const configFilePath = resolveConfigFilePath(cwd, options.configFilePath)

  let merged = deepMerge({}, DEFAULTS)

  if (configFilePath) {
    const contents = fs.readFileSync(configFilePath, 'utf8')
    merged = deepMerge(merged, parseJsonObject(contents, configFilePath) as NessieConfigOverrides)
  }

  merged = deepMerge(merged, parseEnvConfig(env))
  merged = deepMerge(merged, parseCliConfig(argv))

  const result = NessieConfigSchema.safeParse(merged)
  if (!result.success) {
    const issues = collectIssues(result.error.issues)
    throw new NessieConfigError(
      `Invalid Nessie config:\n${formatConfigIssues(issues)}`,
      issues,
    )
  }

  return {
    config: result.data,
    capabilities: deriveRuntimeCapabilities(result.data),
    configFilePath,
  }
}

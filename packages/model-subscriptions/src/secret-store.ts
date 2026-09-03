import { safeFetch } from '@nessie/runtime'
import {
  ModelSubscriptionError,
  SUBSCRIPTION_ERROR_CODES,
  type SubscriptionCredentialBundle,
} from './types.js'

/**
 * Where subscription token bundles live.
 *
 * `docs/secret-management-spec.md` bars new secret-capture flows from putting
 * values in PostgreSQL, so the bundle goes to the deployment's vault and the
 * database keeps only a pointer. This is deliberately its OWN store, separate
 * from `api/src/services/infisical-vault.ts`: that client is write-only by
 * design ("never returns them to a route, model, or caller") and its personal
 * partition also holds a person's ordinary captured secrets, so an identity
 * scoped to it could read them all. A dedicated project is what makes
 * "subscription paths only" an enforceable ACL rather than a promise.
 */
export type SubscriptionSecretStore = {
  read: (name: string) => Promise<SubscriptionCredentialBundle>
  write: (input: { name: string; bundle: SubscriptionCredentialBundle }) => Promise<void>
  remove: (name: string) => Promise<void>
}

const bundleFromJson = (raw: string): SubscriptionCredentialBundle => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ModelSubscriptionError(
      SUBSCRIPTION_ERROR_CODES.CREDENTIAL_MISSING,
      'The stored credential could not be read.',
    )
  }
  const record = parsed as Partial<SubscriptionCredentialBundle> | null
  if (!record || typeof record.accessToken !== 'string' || record.accessToken.length === 0) {
    throw new ModelSubscriptionError(
      SUBSCRIPTION_ERROR_CODES.CREDENTIAL_MISSING,
      'The stored credential could not be read.',
    )
  }
  return {
    accessToken: record.accessToken,
    ...(typeof record.idToken === 'string' ? { idToken: record.idToken } : {}),
    ...(typeof record.refreshToken === 'string' ? { refreshToken: record.refreshToken } : {}),
    ...(typeof record.expiresAt === 'number' ? { expiresAt: record.expiresAt } : {}),
    ...(typeof record.tokenType === 'string' ? { tokenType: record.tokenType } : {}),
    ...(typeof record.scope === 'string' ? { scope: record.scope } : {}),
  }
}

/** Test/local double. Never used when the vault is configured. */
export const createInMemorySubscriptionSecretStore = (): SubscriptionSecretStore & {
  entries: Map<string, string>
} => {
  const entries = new Map<string, string>()
  return {
    entries,
    read: async (name) => {
      const raw = entries.get(name)
      if (raw === undefined) {
        throw new ModelSubscriptionError(
          SUBSCRIPTION_ERROR_CODES.CREDENTIAL_MISSING,
          'The stored credential could not be read.',
        )
      }
      return bundleFromJson(raw)
    },
    remove: async (name) => {
      entries.delete(name)
    },
    write: async ({ bundle, name }) => {
      entries.set(name, JSON.stringify(bundle))
    },
  }
}

type InfisicalSettings = {
  apiUrl: URL
  environment: string
  projectId: string
  serviceToken: string
  secretPath: string
}

const REQUIRED_ENV = [
  'NESSIE_SUBSCRIPTION_VAULT_API_URL',
  'NESSIE_SUBSCRIPTION_VAULT_TOKEN',
  'NESSIE_SUBSCRIPTION_VAULT_PROJECT_ID',
] as const

/**
 * Resolve the dedicated model-subscription vault project from the environment.
 * Returns null when the deployment has not configured one — linking is then
 * refused in words, never silently downgraded to a database column.
 */
export const resolveSubscriptionVaultSettings = (
  env: NodeJS.ProcessEnv = process.env,
): InfisicalSettings | null => {
  const missing = REQUIRED_ENV.filter((name) => !env[name]?.trim())
  if (missing.length > 0) return null
  let apiUrl: URL
  try {
    apiUrl = new URL(env.NESSIE_SUBSCRIPTION_VAULT_API_URL as string)
  } catch {
    return null
  }
  // The vault carries live consumer credentials; a plaintext hop is not an
  // acceptable local convenience, so this is not relaxed outside production.
  if (apiUrl.protocol !== 'https:') return null
  return {
    apiUrl,
    environment: env.NESSIE_SUBSCRIPTION_VAULT_ENVIRONMENT?.trim() || 'prod',
    projectId: env.NESSIE_SUBSCRIPTION_VAULT_PROJECT_ID as string,
    secretPath: '/',
    serviceToken: env.NESSIE_SUBSCRIPTION_VAULT_TOKEN as string,
  }
}

const vaultRequest = async (
  settings: InfisicalSettings,
  input: { body?: unknown; method: string; name: string; query?: Record<string, string> },
): Promise<Response> => {
  const url = new URL(
    `/api/v4/secrets/${encodeURIComponent(input.name)}`,
    settings.apiUrl,
  )
  for (const [key, value] of Object.entries(input.query ?? {})) {
    url.searchParams.set(key, value)
  }
  try {
    return await safeFetch(
      url,
      {
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${settings.serviceToken}`,
          ...(input.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        method: input.method,
        signal: AbortSignal.timeout(10_000),
      },
      { credentialsPresent: true, maxRedirects: 0 },
    )
  } catch {
    throw new ModelSubscriptionError(
      SUBSCRIPTION_ERROR_CODES.VAULT_UNAVAILABLE,
      'The credential vault could not be reached.',
    )
  }
}

const assertOk = async (response: Response): Promise<void> => {
  if (response.ok) return
  await response.body?.cancel().catch(() => undefined)
  throw new ModelSubscriptionError(
    SUBSCRIPTION_ERROR_CODES.VAULT_UNAVAILABLE,
    'The credential vault could not complete this operation.',
  )
}

/**
 * Vault-backed store. Reads are what separate it from the write-only
 * `InfisicalVault`: an unattended run has no user machine to fetch from, so the
 * server must be able to resolve the bundle at dispatch time.
 */
export const createInfisicalSubscriptionSecretStore = (
  settings: InfisicalSettings,
): SubscriptionSecretStore => ({
  read: async (name) => {
    const response = await vaultRequest(settings, {
      method: 'GET',
      name,
      query: {
        environment: settings.environment,
        projectId: settings.projectId,
        secretPath: settings.secretPath,
      },
    })
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined)
      throw new ModelSubscriptionError(
        SUBSCRIPTION_ERROR_CODES.CREDENTIAL_MISSING,
        'The stored credential could not be read.',
      )
    }
    await assertOk(response)
    const payload = (await response.json().catch(() => undefined)) as
      | { secret?: { secretValue?: unknown }; secretValue?: unknown }
      | undefined
    const value = payload?.secret?.secretValue ?? payload?.secretValue
    if (typeof value !== 'string') {
      throw new ModelSubscriptionError(
        SUBSCRIPTION_ERROR_CODES.CREDENTIAL_MISSING,
        'The stored credential could not be read.',
      )
    }
    return bundleFromJson(value)
  },
  remove: async (name) => {
    const response = await vaultRequest(settings, {
      body: {
        environment: settings.environment,
        projectId: settings.projectId,
        secretPath: settings.secretPath,
        type: 'shared',
      },
      method: 'DELETE',
      name,
    })
    // An already-absent secret is a completed deletion, which is what makes
    // the tombstone sweep safely idempotent.
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined)
      return
    }
    await assertOk(response)
  },
  write: async ({ bundle, name }) => {
    const body = {
      environment: settings.environment,
      projectId: settings.projectId,
      secretPath: settings.secretPath,
      secretValue: JSON.stringify(bundle),
      type: 'shared',
    }
    const created = await vaultRequest(settings, { body, method: 'POST', name })
    if (created.ok) {
      await created.body?.cancel().catch(() => undefined)
      return
    }
    await created.body?.cancel().catch(() => undefined)
    await assertOk(await vaultRequest(settings, { body, method: 'PATCH', name }))
  },
})

export const createSubscriptionSecretStoreFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
): SubscriptionSecretStore | null => {
  const settings = resolveSubscriptionVaultSettings(env)
  return settings ? createInfisicalSubscriptionSecretStore(settings) : null
}

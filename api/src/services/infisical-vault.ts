import { readFileSync } from 'node:fs'

import { safeFetch } from '@nessie/runtime'

const REQUIRED_ENV = [
  'INFISICAL_API_URL',
  'INFISICAL_SERVICE_TOKEN',
  'INFISICAL_PROJECT_ID',
] as const

export class InfisicalVaultError extends Error {
  constructor(message: string, readonly code: 'NOT_CONFIGURED' | 'UNAVAILABLE') {
    super(message)
  }
}

type InfisicalSettings = {
  apiUrl: URL
  environment: string
  projectId: string
  serviceToken: string
}

export type InfisicalSecretNamespace = {
  organizationId: string
  scopeId: string
  scopeType: 'personal' | 'team' | 'project' | 'organization'
}

export const infisicalSecretPath = (namespace: InfisicalSecretNamespace): string =>
  `/nessie/${namespace.organizationId}/${namespace.scopeType}/${namespace.scopeId}`

const infisicalNamespaceFolders = (namespace: InfisicalSecretNamespace): Array<{
  name: string
  path: string
}> => [
  { name: 'nessie', path: '/' },
  { name: namespace.organizationId, path: '/nessie' },
  { name: namespace.scopeType, path: `/nessie/${namespace.organizationId}` },
  { name: namespace.scopeId, path: `/nessie/${namespace.organizationId}/${namespace.scopeType}` },
]

const settingsFromEnv = (env: NodeJS.ProcessEnv = process.env): InfisicalSettings => {
  let token = env.INFISICAL_SERVICE_TOKEN?.trim()
  if (env.INFISICAL_SERVICE_TOKEN_FILE?.trim()) {
    try {
      token = readFileSync(env.INFISICAL_SERVICE_TOKEN_FILE, 'utf8').trim()
    } catch {
      token = undefined
    }
  }
  const missing = REQUIRED_ENV.filter((name) =>
    name === 'INFISICAL_SERVICE_TOKEN' ? !token : !env[name]?.trim(),
  )
  if (missing.length > 0) {
    throw new InfisicalVaultError(
      'Secrets are not configured for this deployment.',
      'NOT_CONFIGURED',
    )
  }
  let apiUrl: URL
  try {
    apiUrl = new URL(env.INFISICAL_API_URL as string)
  } catch {
    throw new InfisicalVaultError('Secrets are not configured for this deployment.', 'NOT_CONFIGURED')
  }
  if (apiUrl.protocol !== 'https:') {
    throw new InfisicalVaultError('Secrets are not configured for this deployment.', 'NOT_CONFIGURED')
  }
  return {
    apiUrl,
    environment: env.INFISICAL_ENVIRONMENT?.trim() || 'prod',
    projectId: env.INFISICAL_PROJECT_ID as string,
    serviceToken: token as string,
  }
}

const responseOk = async (response: Response): Promise<void> => {
  if (response.ok) return
  await response.body?.cancel().catch(() => undefined)
  throw new InfisicalVaultError('The vault could not complete this operation.', 'UNAVAILABLE')
}

const fetchInfisical = async (url: URL, init: RequestInit): Promise<Response> => {
  try {
    return await safeFetch(url, init, { credentialsPresent: true, maxRedirects: 0 })
  } catch (error) {
    if (error instanceof InfisicalVaultError) throw error
    throw new InfisicalVaultError('The vault could not complete this operation.', 'UNAVAILABLE')
  }
}

const folderAlreadyExists = async (
  response: Response,
  folder: { name: string; path: string },
): Promise<boolean> => {
  if (response.status === 409) {
    await response.body?.cancel().catch(() => undefined)
    return true
  }
  if (response.status !== 400) return false
  const body = await response.json().catch(() => undefined) as { message?: unknown } | undefined
  return body?.message === `Folder with name '${folder.name}' already exists in path '${folder.path}'`
}

const secretAlreadyExists = async (response: Response, name: string): Promise<boolean> => {
  if (response.status === 409) {
    await response.body?.cancel().catch(() => undefined)
    return true
  }
  if (response.status !== 400) return false
  const body = await response.json().catch(() => undefined) as { message?: unknown } | undefined
  return typeof body?.message === 'string'
    && body.message.includes(name)
    && body.message.toLowerCase().includes('already exists')
}

/**
 * Narrow server-only Infisical boundary. It accepts secret bytes only for a
 * write/rotation request and never returns them to a route, model, or caller.
 */
export class InfisicalVault {
  readonly #settings: InfisicalSettings

  constructor(env?: NodeJS.ProcessEnv) {
    this.#settings = settingsFromEnv(env)
  }

  referenceFor(input: { name: string; namespace: InfisicalSecretNamespace }): string {
    return `infisical://${this.#settings.projectId}/${this.#settings.environment}${infisicalSecretPath(input.namespace)}/${input.name}`
  }

  async #ensureNamespace(namespace: InfisicalSecretNamespace): Promise<void> {
    for (const folder of infisicalNamespaceFolders(namespace)) {
      const response = await fetchInfisical(new URL('/api/v2/folders', this.#settings.apiUrl), {
        body: JSON.stringify({
          environment: this.#settings.environment,
          name: folder.name,
          path: folder.path,
          projectId: this.#settings.projectId,
        }),
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.#settings.serviceToken}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
      })
      // Infisical currently returns a specific 400 for this idempotent case;
      // accept 409 too so concurrent first writes remain safe across versions.
      if (await folderAlreadyExists(response, folder)) continue
      await responseOk(response)
    }
  }

  async put(input: {
    name: string
    value: string
    description?: string
    namespace: InfisicalSecretNamespace
  }): Promise<string> {
    await this.#ensureNamespace(input.namespace)
    const url = new URL(`/api/v4/secrets/${encodeURIComponent(input.name)}`, this.#settings.apiUrl)
    const response = await fetchInfisical(url, {
      body: JSON.stringify({
        environment: this.#settings.environment,
        projectId: this.#settings.projectId,
        secretComment: input.description ?? '',
        secretPath: infisicalSecretPath(input.namespace),
        secretValue: input.value,
        type: 'shared',
      }),
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.#settings.serviceToken}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
    })
    if (await secretAlreadyExists(response, input.name)) {
      // A prior metadata failure may have left this deterministic vault name
      // behind. Replacing it makes the same protected capture retryable while
      // the advisory lock still guarantees one writer for this identity.
      await this.replace(input)
    } else {
      await responseOk(response)
    }
    return this.referenceFor(input)
  }

  async replace(input: {
    name: string
    value: string
    description?: string
    namespace: InfisicalSecretNamespace
  }): Promise<void> {
    const url = new URL(`/api/v4/secrets/${encodeURIComponent(input.name)}`, this.#settings.apiUrl)
    const response = await fetchInfisical(url, {
      body: JSON.stringify({
        environment: this.#settings.environment,
        projectId: this.#settings.projectId,
        secretComment: input.description ?? '',
        secretPath: infisicalSecretPath(input.namespace),
        secretValue: input.value,
        type: 'shared',
      }),
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.#settings.serviceToken}`,
        'Content-Type': 'application/json',
      },
      method: 'PATCH',
      signal: AbortSignal.timeout(10_000),
    })
    await responseOk(response)
  }

  async remove(input: { name: string; namespace: InfisicalSecretNamespace }): Promise<void> {
    const url = new URL(`/api/v4/secrets/${encodeURIComponent(input.name)}`, this.#settings.apiUrl)
    const response = await fetchInfisical(url, {
      body: JSON.stringify({
        environment: this.#settings.environment,
        projectId: this.#settings.projectId,
        secretPath: infisicalSecretPath(input.namespace),
        type: 'shared',
      }),
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.#settings.serviceToken}`,
        'Content-Type': 'application/json',
      },
      method: 'DELETE',
      signal: AbortSignal.timeout(10_000),
    })
    await responseOk(response)
  }
}

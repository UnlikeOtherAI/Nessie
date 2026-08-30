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

/**
 * Narrow server-only Infisical boundary. It accepts secret bytes only for a
 * write/rotation request and never returns them to a route, model, or caller.
 */
export class InfisicalVault {
  readonly #settings: InfisicalSettings

  constructor(env?: NodeJS.ProcessEnv) {
    this.#settings = settingsFromEnv(env)
  }

  referenceFor(secretName: string): string {
    return `infisical://${this.#settings.projectId}/${this.#settings.environment}/nessie/${secretName}`
  }

  async put(input: { name: string; value: string; description?: string }): Promise<string> {
    const url = new URL(`/api/v4/secrets/${encodeURIComponent(input.name)}`, this.#settings.apiUrl)
    const response = await safeFetch(url, {
      body: JSON.stringify({
        environment: this.#settings.environment,
        projectId: this.#settings.projectId,
        secretComment: input.description ?? '',
        secretPath: '/nessie',
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
    }, { credentialsPresent: true, maxRedirects: 0 })
    await responseOk(response)
    return this.referenceFor(input.name)
  }

  async replace(input: { name: string; value: string; description?: string }): Promise<void> {
    const url = new URL(`/api/v4/secrets/${encodeURIComponent(input.name)}`, this.#settings.apiUrl)
    const response = await safeFetch(url, {
      body: JSON.stringify({
        environment: this.#settings.environment,
        projectId: this.#settings.projectId,
        secretComment: input.description ?? '',
        secretPath: '/nessie',
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
    }, { credentialsPresent: true, maxRedirects: 0 })
    await responseOk(response)
  }

  async remove(name: string): Promise<void> {
    const url = new URL(`/api/v4/secrets/${encodeURIComponent(name)}`, this.#settings.apiUrl)
    const response = await safeFetch(url, {
      body: JSON.stringify({
        environment: this.#settings.environment,
        projectId: this.#settings.projectId,
        secretPath: '/nessie',
        type: 'shared',
      }),
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.#settings.serviceToken}`,
        'Content-Type': 'application/json',
      },
      method: 'DELETE',
      signal: AbortSignal.timeout(10_000),
    }, { credentialsPresent: true, maxRedirects: 0 })
    await responseOk(response)
  }
}

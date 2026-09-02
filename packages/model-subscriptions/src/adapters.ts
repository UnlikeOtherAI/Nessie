import { createHash } from 'node:crypto'
import { safeFetch } from '@nessie/runtime'
import {
  ModelSubscriptionError,
  SUBSCRIPTION_ERROR_CODES,
  type SubscriptionAccountIdentity,
  type SubscriptionCredentialBundle,
  type SubscriptionFailureKind,
  type SubscriptionProviderAdapter,
  type SubscriptionProviderKey,
} from './types.js'

/**
 * A pasted key has no OIDC subject, so the account identity is a fingerprint of
 * the key itself. It is stable for the life of the key, distinguishes two keys
 * from the same person, and discloses nothing — the raw key is never derivable
 * from it.
 */
export const fingerprintApiKey = (key: string): string =>
  createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 32)

/** `sk-…4f2a` — enough to tell two linked keys apart, never enough to use one. */
export const maskApiKey = (key: string): string => {
  const trimmed = key.trim()
  if (trimmed.length <= 8) return '••••'
  return `${trimmed.slice(0, 3)}…${trimmed.slice(-4)}`
}

/**
 * Shared failure classification for OpenAI-shaped providers.
 *
 * 401 is authentication. 403 deliberately is NOT: providers reuse it for
 * missing entitlement, plan restrictions and content policy, and flipping a
 * healthy link to `needs_reauthorization` would show a person a relink button
 * that cannot fix their problem.
 */
export const classifyOpenAiShapedFailure = (input: {
  status: number
  body?: unknown
}): SubscriptionFailureKind => {
  if (input.status === 401) return 'auth'
  if (input.status === 429) return 'quota'
  if (input.status === 402) return 'quota'
  if (input.status === 403) {
    const code = readProviderCode(input.body)
    if (code === 'invalid_api_key' || code === 'unauthorized' || code === 'invalid_token') {
      return 'auth'
    }
    if (code === 'insufficient_quota' || code === 'rate_limit_exceeded') return 'quota'
    if (code === 'content_policy_violation') return 'policy'
    return 'entitlement'
  }
  if (input.status >= 500) return 'transient'
  return 'unknown'
}

const readProviderCode = (body: unknown): string | null => {
  if (!body || typeof body !== 'object') return null
  const error = (body as { error?: unknown }).error
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string') return code
    const type = (error as { type?: unknown }).type
    if (typeof type === 'string') return type
  }
  const code = (body as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

/**
 * Verify by listing models on the provider's own base URL. The URL is an
 * adapter constant, so this can never be steered by a caller.
 */
const verifyByModelList = async (
  input: {
    baseUrl: string
    bundle: SubscriptionCredentialBundle
    displayName: string
    path?: string
  },
): Promise<SubscriptionAccountIdentity> => {
  const url = new URL(input.path ?? '/models', `${input.baseUrl.replace(/\/+$/, '')}/`)
  let response: Response
  try {
    response = await safeFetch(
      url,
      {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${input.bundle.accessToken}`,
        },
        method: 'GET',
        signal: AbortSignal.timeout(15_000),
      },
      { credentialsPresent: true, maxRedirects: 0 },
    )
  } catch {
    throw new ModelSubscriptionError(
      SUBSCRIPTION_ERROR_CODES.VERIFY_FAILED,
      `${input.displayName} could not be reached to check this key.`,
    )
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new ModelSubscriptionError(
      SUBSCRIPTION_ERROR_CODES.VERIFY_FAILED,
      response.status === 401 || response.status === 403
        ? `${input.displayName} rejected this key.`
        : `${input.displayName} could not confirm this key right now.`,
    )
  }
  await response.body?.cancel().catch(() => undefined)
  return {
    accountLabel: maskApiKey(input.bundle.accessToken),
    providerAccountId: fingerprintApiKey(input.bundle.accessToken),
  }
}

/**
 * Kimi for Coding. The subscription key comes from the Kimi console and rides
 * the existing compiled `kimi` connector (Anthropic Messages wire format) at
 * its own base URL.
 */
const kimiAdapter: SubscriptionProviderAdapter = {
  authStrategy: 'api_key',
  classifyFailure: classifyOpenAiShapedFailure,
  displayName: 'Kimi for Coding',
  key: 'kimi',
  models: [
    {
      description: 'Kimi’s coding-plan model.',
      displayName: 'Kimi for Coding',
      model: 'kimi-for-coding',
    },
  ],
  termsNote:
    'Runs on your own Kimi for Coding plan and counts against your personal usage limits, not your organisation’s credits. Nessie stores the key so your agents can use it while you are away.',
  transport: {
    baseUrl: 'https://api.kimi.com/coding',
    runtimeProvider: 'kimi',
  },
  // The coding endpoint speaks Anthropic Messages and exposes no model list, so
  // the key is accepted on shape here and proven by its first real dispatch,
  // which fails closed with a named remedy rather than a silent wrong answer.
  verify: async (bundle) => ({
    accountLabel: maskApiKey(bundle.accessToken),
    providerAccountId: fingerprintApiKey(bundle.accessToken),
  }),
}

/**
 * Z.ai / Zhipu GLM coding plan. Pinned to the documented OpenAI-compatible
 * endpoint (not probed at runtime), so "no new connector work" actually holds:
 * the generic `openai-compatible` connector carries it unchanged.
 */
const glmAdapter: SubscriptionProviderAdapter = {
  authStrategy: 'api_key',
  classifyFailure: classifyOpenAiShapedFailure,
  displayName: 'GLM Coding Plan',
  key: 'glm',
  models: [
    { description: 'Z.ai’s flagship GLM model.', displayName: 'GLM-4.6', model: 'glm-4.6' },
    { description: 'Faster, lighter GLM.', displayName: 'GLM-4.5-Air', model: 'glm-4.5-air' },
  ],
  termsNote:
    'Runs on your own GLM coding plan and counts against your personal usage limits, not your organisation’s credits. Nessie stores the key so your agents can use it while you are away.',
  transport: {
    baseUrl: 'https://api.z.ai/api/paas/v4',
    runtimeProvider: 'openai-compatible',
  },
  verify: async (bundle) =>
    verifyByModelList({
      baseUrl: 'https://api.z.ai/api/paas/v4',
      bundle,
      displayName: 'Z.ai',
    }),
}

const ADAPTERS: Partial<Record<SubscriptionProviderKey, SubscriptionProviderAdapter>> = {
  glm: glmAdapter,
  kimi: kimiAdapter,
}

/** Adapters a person can link today. Codex and Grok land with phase 2. */
export const listSubscriptionAdapters = (): SubscriptionProviderAdapter[] =>
  Object.values(ADAPTERS).filter((adapter): adapter is SubscriptionProviderAdapter =>
    adapter !== undefined,
  )

export const findSubscriptionAdapter = (
  key: string,
): SubscriptionProviderAdapter | null =>
  ADAPTERS[key as SubscriptionProviderKey] ?? null

export const requireSubscriptionAdapter = (
  key: string,
): SubscriptionProviderAdapter => {
  const adapter = findSubscriptionAdapter(key)
  if (!adapter) {
    throw new ModelSubscriptionError(
      SUBSCRIPTION_ERROR_CODES.ADAPTER_UNKNOWN,
      'That subscription provider is not available.',
    )
  }
  return adapter
}

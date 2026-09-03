import { createHash } from 'node:crypto'
import { safeFetch } from '@nessie/runtime'
import {
  createCodexDeviceFlow,
  createGrokDeviceFlow,
  OPENAI_AUTH_BASE_URL,
  OPENAI_CODEX_CLIENT_ID,
  readIdTokenIdentity,
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_ISSUER,
  type DeviceAuthorizationFlow,
} from './device-auth.js'
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

// ─── OAuth device-code adapters (phase 2) ────────────────────────────────────

/**
 * Refresh an OAuth grant.
 *
 * A refresh grant is never retried on a transport failure: the provider may
 * already have consumed and rotated the token, and a resend would burn the
 * family. The caller (the coordinator) parks the link for recovery instead.
 */
const refreshOAuthGrant = async (input: {
  bundle: SubscriptionCredentialBundle
  clientId: string
  displayName: string
  tokenEndpoint: string
  extraHeaders?: Record<string, string>
}): Promise<SubscriptionCredentialBundle> => {
  const refreshToken = input.bundle.refreshToken
  if (!refreshToken) {
    throw new ModelSubscriptionError(
      SUBSCRIPTION_ERROR_CODES.VERIFY_FAILED,
      `${input.displayName} cannot be refreshed without a refresh token.`,
    )
  }
  let response: Response
  try {
    response = await safeFetch(
      input.tokenEndpoint,
      {
        body: new URLSearchParams({
          client_id: input.clientId,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }).toString(),
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          ...(input.extraHeaders ?? {}),
        },
        method: 'POST',
        signal: AbortSignal.timeout(30_000),
      },
      { credentialsPresent: true, maxRedirects: 0 },
    )
  } catch {
    throw new ModelSubscriptionError(
      SUBSCRIPTION_ERROR_CODES.REFRESH_INDETERMINATE,
      `${input.displayName} could not be refreshed.`,
    )
  }
  const text = await response.text().catch(() => '')
  let body: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>
  } catch {
    body = {}
  }
  if (!response.ok) {
    throw new ModelSubscriptionError(
      SUBSCRIPTION_ERROR_CODES.VERIFY_FAILED,
      `${input.displayName} rejected the refresh; reconnect the subscription.`,
    )
  }
  const accessToken = typeof body.access_token === 'string' ? body.access_token : ''
  if (!accessToken) {
    throw new ModelSubscriptionError(
      SUBSCRIPTION_ERROR_CODES.VERIFY_FAILED,
      `${input.displayName} returned no access token on refresh.`,
    )
  }
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : undefined
  return {
    accessToken,
    // A provider that omits `refresh_token` on refresh means "unchanged"; one
    // that rotates it hands back a new one, and dropping that would strand the
    // family at the next refresh.
    ...(typeof body.refresh_token === 'string' && body.refresh_token.trim()
      ? { refreshToken: body.refresh_token }
      : { refreshToken }),
    ...(typeof body.id_token === 'string' ? { idToken: body.id_token } : input.bundle.idToken ? { idToken: input.bundle.idToken } : {}),
    ...(expiresIn ? { expiresAt: Date.now() + expiresIn * 1000 } : {}),
  }
}

/**
 * OpenAI Codex on a ChatGPT plan. Nessie runs its own device-code grant against
 * OpenAI's public Codex client and identifies itself with `originator=nessie` —
 * it never reads the Codex CLI's stored credentials, because two apps sharing
 * one grant rotate each other out.
 */
const codexAdapter: SubscriptionProviderAdapter = {
  authStrategy: 'oauth_device',
  classifyFailure: classifyOpenAiShapedFailure,
  displayName: 'ChatGPT Codex',
  key: 'openai_codex',
  models: [
    { description: 'OpenAI’s Codex model.', displayName: 'GPT-5 Codex', model: 'gpt-5-codex' },
  ],
  refresh: async (bundle) =>
    refreshOAuthGrant({
      bundle,
      clientId: OPENAI_CODEX_CLIENT_ID,
      displayName: 'OpenAI',
      extraHeaders: { originator: 'nessie' },
      tokenEndpoint: `${OPENAI_AUTH_BASE_URL}/oauth/token`,
    }),
  termsNote:
    'Signs in to your own ChatGPT account and runs against your plan’s limits, not your organisation’s credits. Nessie keeps its own sign-in, separate from the Codex CLI, so the two never sign each other out. Check that your plan permits use from other tools.',
  transport: {
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    runtimeProvider: 'codex-subscription',
  },
  transportHeaders: (bundle) => {
    const accountId = bundle.idToken
      ? readChatgptAccountId(bundle.idToken)
      : undefined
    return {
      'OpenAI-Beta': 'responses=experimental',
      originator: 'nessie',
      ...(accountId ? { 'chatgpt-account-id': accountId } : {}),
    }
  },
  // The device flow already proved the account through the id_token; a second
  // probe would spend a generation to learn nothing new.
  verify: async (bundle) =>
    bundle.idToken
      ? readIdTokenIdentity(bundle.idToken, {
        audience: OPENAI_CODEX_CLIENT_ID,
        issuer: OPENAI_AUTH_BASE_URL,
      })
      : { providerAccountId: fingerprintApiKey(bundle.refreshToken ?? bundle.accessToken) },
}

/** ChatGPT routes Codex requests per workspace account, named in the id_token. */
const readChatgptAccountId = (idToken: string): string | undefined => {
  const payloadPart = idToken.split('.')[1]
  if (!payloadPart) return undefined
  try {
    const claims = JSON.parse(
      Buffer.from(payloadPart, 'base64url').toString('utf8'),
    ) as Record<string, unknown>
    const auth = (claims['https://api.openai.com/auth'] ?? {}) as Record<string, unknown>
    const id = auth.chatgpt_account_id
    return typeof id === 'string' && id.trim().length > 0 ? id : undefined
  } catch {
    return undefined
  }
}

/**
 * xAI Grok on a SuperGrok plan. Standard OIDC discovery plus RFC 8628 device
 * code — no loopback listener anywhere. xAI's consent screen may name "Grok
 * Build", because this is xAI's shared public client; the linking copy says so.
 */
const grokAdapter: SubscriptionProviderAdapter = {
  authStrategy: 'oauth_device',
  classifyFailure: classifyOpenAiShapedFailure,
  displayName: 'Grok (SuperGrok)',
  key: 'grok',
  models: [
    { description: 'xAI’s flagship Grok model.', displayName: 'Grok 4', model: 'grok-4' },
    { description: 'Fast Grok model for coding.', displayName: 'Grok Code Fast', model: 'grok-code-fast-1' },
  ],
  refresh: async (bundle) =>
    refreshOAuthGrant({
      bundle,
      clientId: XAI_OAUTH_CLIENT_ID,
      displayName: 'xAI',
      tokenEndpoint: `${XAI_OAUTH_ISSUER}/oauth/token`,
    }),
  termsNote:
    'Signs in to your own xAI account and runs against your SuperGrok plan’s limits, not your organisation’s credits. xAI may show “Grok Build” on the consent screen, because Nessie uses xAI’s shared sign-in app. Your account needs an eligible subscription.',
  transport: {
    baseUrl: 'https://cli-chat-proxy.grok.com/v1',
    runtimeProvider: 'openai-compatible',
  },
  transportHeaders: () => ({ 'X-XAI-Token-Auth': 'xai-grok-cli' }),
  verify: async (bundle) =>
    bundle.idToken
      ? readIdTokenIdentity(bundle.idToken, {
        audience: XAI_OAUTH_CLIENT_ID,
        issuer: XAI_OAUTH_ISSUER,
      })
      : { providerAccountId: fingerprintApiKey(bundle.refreshToken ?? bundle.accessToken) },
}

/** The device flow for an adapter, or null for a pasted-key provider. */
export const deviceFlowForAdapter = (
  key: SubscriptionProviderKey,
): DeviceAuthorizationFlow | null => {
  if (key === 'openai_codex') return createCodexDeviceFlow()
  if (key === 'grok') return createGrokDeviceFlow()
  return null
}

/**
 * The adapters this deployment can link. Declared after every adapter above so
 * the phase-2 OAuth providers can sit beside the pasted-key ones without a
 * forward reference.
 */
const ADAPTERS: Partial<Record<SubscriptionProviderKey, SubscriptionProviderAdapter>> = {
  glm: glmAdapter,
  grok: grokAdapter,
  kimi: kimiAdapter,
  openai_codex: codexAdapter,
}

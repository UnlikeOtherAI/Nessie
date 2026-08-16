import { Prisma } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import type { ModelConfig, ModelProvider } from '@nessie/config'
import { isLedgerEndpoint } from '@nessie/runtime'

const DEFAULT_MODEL_BY_PROVIDER: Record<ModelProvider, string> = {
  minimax: 'MiniMax-M2.5',
  kimi: 'kimi-for-coding',
  deepseek: 'deepseek-v4-flash',
  openai: 'gpt-5-mini',
}

export type RunnableProvider = ModelProvider | 'openai-compatible'

export type ResolvedProviderConfig = {
  apiKey: string
  baseUrl?: string
  connectorKind?: 'compiled' | 'openai-compatible'
  model: string
  providerKey: string
}

export const resolveRuntimeProvider = (providerKey: string): RunnableProvider | null => {
  const normalized = providerKey.trim().toLowerCase()
  if (normalized === 'openai') {
    return 'openai'
  }
  if (normalized === 'openai-compatible') {
    return 'openai-compatible'
  }
  if (normalized === 'minimax') {
    return 'minimax'
  }
  if (normalized === 'kimi') {
    return 'kimi'
  }
  if (normalized === 'deepseek') {
    return 'deepseek'
  }
  return null
}

export const resolveModelName = (
  provider: ModelProvider,
  requestedModel?: string | null,
): string => requestedModel?.trim() || DEFAULT_MODEL_BY_PROVIDER[provider]

const resolveLegacyApiKey = (provider: ModelProvider, modelConfig: ModelConfig): string => {
  if (provider === 'openai') {
    return (
      (modelConfig.provider === 'openai' ? modelConfig.apiKey : undefined) ??
      process.env.OPENAI_CHAT_API_KEY ??
      process.env.OPENAI_API_KEY ??
      ''
    )
  }

  if (provider === 'deepseek') {
    return (
      (modelConfig.provider === 'deepseek' ? modelConfig.apiKey : undefined) ??
      process.env.DEEPSEEK_API_KEY ??
      ''
    )
  }

  if (provider === 'kimi') {
    return (
      (modelConfig.provider === 'kimi' ? modelConfig.apiKey : undefined) ??
      process.env.KIMI_API_KEY ??
      ''
    )
  }

  return (modelConfig.provider === 'minimax' ? modelConfig.apiKey : undefined)
    ?? process.env.MINIMAX_API_KEY
    ?? ''
}

const resolveBoundApiKey = (authSecretRef: string | null | undefined): string =>
  authSecretRef ? process.env[authSecretRef] ?? '' : ''

export const resolveStageApiKey = (input: {
  authSecretRef?: string | null
  baseUrl?: string | null
  modelConfig: ModelConfig
  runtimeProvider: RunnableProvider | null
}): string => {
  // A Ledger base URL is a deployment chokepoint. Nessie's product-bound Ledger
  // app API key is not an interchangeable provider credential, so never forward
  // an org binding or a stale direct-provider environment secret to Ledger.
  if (isLedgerEndpoint(input.baseUrl ?? input.modelConfig.baseUrl)) {
    return input.modelConfig.apiKey ?? ''
  }
  return (
    resolveBoundApiKey(input.authSecretRef)
    || (
      input.runtimeProvider
      && input.runtimeProvider !== 'openai-compatible'
        ? resolveLegacyApiKey(input.runtimeProvider, input.modelConfig)
        : ''
    )
  )
}

export const resolveStageProviderConfig = async (
  prisma: PrismaClient,
  input: {
    modelConfig: ModelConfig
    organizationId: string
    providerKey: string
    requestedModel: string
    routeSource: 'direct' | 'routing-profile'
  },
): Promise<ResolvedProviderConfig> => {
  const runtimeProvider = resolveRuntimeProvider(input.providerKey)
  const providerRows = await prisma.$queryRaw<
    Array<{
      authSecretRef: string | null
      baseUrl: string | null
      connectorKind: 'compiled' | 'openai_compatible'
      id: string
    }>
  >(
    Prisma.sql`
      SELECT
        p.id,
        p.connector_kind::text AS "connectorKind",
        p.base_url AS "baseUrl",
        b.auth_secret_ref AS "authSecretRef"
      FROM inference_providers p
      -- A revoked binding is a withdrawn credential. The control plane detaches
      -- one when it revokes it, and migration
      -- 20260816090000_retire_grandfathered_inference_env_refs retired every
      -- grandfathered env ref the same way; this join states the invariant on
      -- the reading side too, so revocation can never be undone by a stray
      -- active_credential_binding_id.
      LEFT JOIN inference_credential_bindings b
        ON b.id = p.active_credential_binding_id
       AND b.revoked_at IS NULL
      WHERE p.organization_id = ${input.organizationId}::uuid
        AND p.provider_key = ${input.providerKey}
        AND p.enabled = true
        AND p.lifecycle_status = 'approved'
      LIMIT 1
    `,
  )

  const providerRecord = providerRows[0]
  if (input.routeSource === 'routing-profile' && !providerRecord) {
    throw new Error(`Routing profile provider ${input.providerKey} is not runnable`)
  }

  if (providerRecord) {
    const modelRows = await prisma.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`
        SELECT id
        FROM inference_models
        WHERE organization_id = ${input.organizationId}::uuid
          AND provider_id = ${providerRecord.id}::uuid
          AND model = ${input.requestedModel}
          AND enabled = true
          AND lifecycle_status = 'approved'
        LIMIT 1
      `,
    )

    const modelRecord = modelRows[0]

    if (!modelRecord && input.routeSource === 'routing-profile') {
      throw new Error(
        `Routing profile model ${input.requestedModel} for provider ${input.providerKey} is not runnable`,
      )
    }
  }

  const connectorKind =
    providerRecord?.connectorKind === 'openai_compatible'
      ? 'openai-compatible'
      : 'compiled'

  const baseUrl = input.modelConfig.baseUrl ?? providerRecord?.baseUrl ?? undefined
  const apiKey = resolveStageApiKey({
    authSecretRef: providerRecord?.authSecretRef,
    baseUrl,
    modelConfig: input.modelConfig,
    runtimeProvider,
  })

  if (!apiKey) {
    throw new Error(`Missing API key for provider ${input.providerKey}`)
  }

  return {
    apiKey,
    // A deployment-wide base URL is the routing chokepoint (production points
    // this at Ledger). It intentionally wins over legacy per-org provider URLs
    // so an agent selection cannot bypass metering or signed attribution.
    baseUrl,
    connectorKind,
    model: runtimeProvider && runtimeProvider !== 'openai-compatible'
      ? resolveModelName(runtimeProvider, input.requestedModel)
      : input.requestedModel,
    providerKey: input.providerKey,
  }
}

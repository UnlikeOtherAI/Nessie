import type { ModelConfig } from '@nessie/config'
import type { AuthorizedActionContext } from '@nessie/schemas'
import { type AgentModelOption, AgentModelOptionSchema } from '@nessie/schemas'
import {
  attributionFromActorContext,
  type LedgerIdentityService,
} from '@nessie/runtime'
import { z } from 'zod'
import { compareAgentModelOptions } from './agent-model-order.js'

const DEFAULT_LEDGER_URL = 'https://ledger.unlikeotherai.com'
const LEDGER_MODELS_PATH = '/v1/models'
const LEDGER_MODELS_TIMEOUT_MS = 10_000

const LedgerModelListSchema = z.object({
  data: z.array(z.object({
    id: z.string(),
    kind: z.string().optional(),
    display_name: z.string().optional(),
    description: z.string().optional(),
    service: z.object({
      id: z.string(),
      name: z.string(),
    }).optional(),
    endpoints: z.array(z.string()).optional(),
  })),
})

export const LEDGER_AGENT_MODEL_CATALOG_ERROR_CODES = {
  INVALID_RESPONSE: 'LEDGER_MODEL_CATALOG_INVALID_RESPONSE',
  MODEL_NOT_AVAILABLE: 'LEDGER_AGENT_MODEL_NOT_AVAILABLE',
  REQUEST_FAILED: 'LEDGER_MODEL_CATALOG_REQUEST_FAILED',
  UNCONFIGURED: 'LEDGER_MODEL_CATALOG_UNCONFIGURED',
} as const

type LedgerAgentModelCatalogErrorCode =
  (typeof LEDGER_AGENT_MODEL_CATALOG_ERROR_CODES)[keyof typeof LEDGER_AGENT_MODEL_CATALOG_ERROR_CODES]

export class LedgerAgentModelCatalogError extends Error {
  override readonly name = 'LedgerAgentModelCatalogError'

  constructor(
    readonly code: LedgerAgentModelCatalogErrorCode,
    message: string,
  ) {
    super(message)
  }
}

type LedgerAgentModelCatalogConfig = Pick<ModelConfig, 'apiKey' | 'baseUrl'>

type ListLedgerAgentModelsOptions = {
  config: LedgerAgentModelCatalogConfig
  fetchImpl?: typeof fetch
  ledgerPublicUrl?: string
  requestHeaders?: Record<string, string>
}

const trimmed = (value: string | undefined): string | undefined => {
  const result = value?.trim()
  return result || undefined
}

const ledgerModelsEndpoint = (input: {
  baseUrl: string | undefined
  ledgerPublicUrl: string | undefined
}): URL => {
  const baseUrl = trimmed(input.baseUrl)
  if (!baseUrl) {
    throw new LedgerAgentModelCatalogError(
      LEDGER_AGENT_MODEL_CATALOG_ERROR_CODES.UNCONFIGURED,
      'Agent model selection requires a configured Ledger model URL.',
    )
  }

  try {
    const configuredLedgerUrl = new URL(
      trimmed(input.ledgerPublicUrl) ?? DEFAULT_LEDGER_URL,
    )
    const configuredModelUrl = new URL(baseUrl)
    if (configuredModelUrl.origin !== configuredLedgerUrl.origin) {
      throw new Error('model URL does not point to Ledger')
    }
    return new URL(LEDGER_MODELS_PATH, configuredLedgerUrl.origin)
  } catch {
    throw new LedgerAgentModelCatalogError(
      LEDGER_AGENT_MODEL_CATALOG_ERROR_CODES.UNCONFIGURED,
      'Agent model selection requires a configured Ledger model URL.',
    )
  }
}

const optionKey = (option: Pick<AgentModelOption, 'model' | 'provider'>): string =>
  `${option.provider}\u0000${option.model}`

/**
 * Keep catalogue discovery on the same authenticated path as model inference:
 * a signing deployment signs the listing with the caller's user/run provenance
 * and still fails closed when that user has no linked UOA identity. A
 * deployment with no signer configured lists on the Ledger API key alone, which
 * is exactly what the token scopes the catalogue to — see
 * `loadLedgerIdentitySettings`. `listLedgerAgentModels` adds the bearer.
 */
export const ledgerAgentModelCatalogRequestHeaders = async (input: {
  actorContext: AuthorizedActionContext
  ledgerIdentity: LedgerIdentityService | null
}): Promise<Record<string, string>> => {
  if (!input.ledgerIdentity) {
    return {}
  }

  try {
    return await input.ledgerIdentity.requestHeaders(
      attributionFromActorContext(input.actorContext, {
        systemComponent: 'agent-model-catalog',
      }),
      { requireUoaIdentity: true },
    )
  } catch {
    throw new LedgerAgentModelCatalogError(
      LEDGER_AGENT_MODEL_CATALOG_ERROR_CODES.REQUEST_FAILED,
      'Agent model selection requires a linked UnlikeOtherAI identity for the active team.',
    )
  }
}

const toAgentModelOptions = (
  payload: z.infer<typeof LedgerModelListSchema>,
): AgentModelOption[] => {
  const options = new Map<string, AgentModelOption>()

  for (const entry of payload.data) {
    const serviceId = trimmed(entry.service?.id)
    const serviceName = trimmed(entry.service?.name)
    const model = trimmed(entry.id)
    if (
      entry.kind !== 'service'
      || !serviceId
      || !serviceName
      || !model
      || !entry.endpoints?.includes('chat/completions')
    ) {
      continue
    }

    const displayName = trimmed(entry.display_name) ?? model
    const description = trimmed(entry.description)
    const option = AgentModelOptionSchema.parse({
      displayName,
      ...(description ? { description } : {}),
      model,
      provider: serviceId,
      providerDisplayName: serviceName,
    })
    options.set(optionKey(option), option)
  }

  return [...options.values()].sort(compareAgentModelOptions)
}

/**
 * Load only models that can power the agentic loop. Ledger also lists models
 * for embeddings, images, and incompatible protocols; those cannot service
 * Nessie's OpenAI chat-completions loop and are intentionally excluded.
 */
export const listLedgerAgentModels = async (
  input: ListLedgerAgentModelsOptions,
): Promise<AgentModelOption[]> => {
  const apiKey = trimmed(input.config.apiKey)
  if (!apiKey) {
    throw new LedgerAgentModelCatalogError(
      LEDGER_AGENT_MODEL_CATALOG_ERROR_CODES.UNCONFIGURED,
      'Agent model selection requires a configured Ledger model API key.',
    )
  }

  const endpoint = ledgerModelsEndpoint({
    baseUrl: input.config.baseUrl,
    ledgerPublicUrl: input.ledgerPublicUrl,
  })
  const headers = new Headers(input.requestHeaders)
  headers.set('Authorization', `Bearer ${apiKey}`)

  let response: Response
  try {
    response = await (input.fetchImpl ?? fetch)(endpoint, {
      headers,
      method: 'GET',
      signal: AbortSignal.timeout(LEDGER_MODELS_TIMEOUT_MS),
    })
  } catch {
    throw new LedgerAgentModelCatalogError(
      LEDGER_AGENT_MODEL_CATALOG_ERROR_CODES.REQUEST_FAILED,
      'Ledger model catalog could not be reached.',
    )
  }

  if (!response.ok) {
    throw new LedgerAgentModelCatalogError(
      LEDGER_AGENT_MODEL_CATALOG_ERROR_CODES.REQUEST_FAILED,
      `Ledger model catalog request failed with HTTP ${response.status}.`,
    )
  }

  const parsed = LedgerModelListSchema.safeParse(
    await response.json().catch(() => null),
  )
  if (!parsed.success) {
    throw new LedgerAgentModelCatalogError(
      LEDGER_AGENT_MODEL_CATALOG_ERROR_CODES.INVALID_RESPONSE,
      'Ledger model catalog returned an invalid response.',
    )
  }

  return toAgentModelOptions(parsed.data)
}

export const assertLedgerAgentModelSelection = async (input: {
  config: LedgerAgentModelCatalogConfig
  ledgerPublicUrl?: string
  model: string | undefined
  provider: string | undefined
  requestHeaders?:
    | Record<string, string>
    | (() => Promise<Record<string, string>>)
}): Promise<void> => {
  const model = trimmed(input.model)
  const provider = trimmed(input.provider)
  if (!model && !provider) {
    return
  }
  if (!model || !provider) {
    throw new LedgerAgentModelCatalogError(
      LEDGER_AGENT_MODEL_CATALOG_ERROR_CODES.MODEL_NOT_AVAILABLE,
      'Select a model from the available Ledger models.',
    )
  }

  const requestHeaders =
    typeof input.requestHeaders === 'function'
      ? await input.requestHeaders()
      : input.requestHeaders
  const availableModels = await listLedgerAgentModels({
    config: input.config,
    ledgerPublicUrl: input.ledgerPublicUrl,
    requestHeaders,
  })
  if (!availableModels.some((option) => option.model === model && option.provider === provider)) {
    throw new LedgerAgentModelCatalogError(
      LEDGER_AGENT_MODEL_CATALOG_ERROR_CODES.MODEL_NOT_AVAILABLE,
      'Select a model from the available Ledger models.',
    )
  }
}

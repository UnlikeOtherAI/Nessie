import type { ModelConfig } from '@nessie/config'
import type { AuthorizedActionContext, PaginationDirection, PaginationMeta } from '@nessie/schemas'
import type { AgentModelOption } from '@nessie/schemas'
import {
  listLedgerAgentModels,
  MODEL_PAIR_SEPARATOR,
  modelPairKey,
} from '@nessie/team-admin'

import type {
  DeploymentModelCatalogFilters,
  DeploymentModelRecord,
  SetDeploymentModelsEnabledResult,
} from '../contracts/inference-model-catalog.js'
import { asJsonValue, type PrismaClient } from './inference-control-plane-core.js'

/**
 * The deployment's model catalogue, as the owner-facing Models page reads and
 * writes it.
 *
 * Two facts shape everything here.
 *
 * **The list is Ledger's.** Nothing local enumerates "every model available in
 * the deployment"; Ledger does, per request. So this reads the live catalogue
 * and left-joins the organisation's own `inference_models` rows onto it. A pair
 * with no row is available — the Ledger default — and a Ledger read that fails
 * throws rather than returning a stale guess for the page to render.
 *
 * **A row written here is a container, never a routing override.** The worker's
 * org-provider path only honours a provider/model that is
 * `enabled = true AND lifecycle_status = 'approved'`, so the provider row this
 * upserts stays `draft` and disabled. That keeps one column from carrying two
 * meanings: the page decides selectability, and nothing it writes can redirect
 * a run. See docs/standards/inference-model-availability.md.
 */

/** Everything needed to read the live catalogue for one organisation. */
export type DeploymentModelCatalogSource = {
  config: Pick<ModelConfig, 'apiKey' | 'baseUrl'>
  ledgerPublicUrl?: string | undefined
  organizationId: string
  requestHeaders?: Record<string, string> | undefined
}

export type DeploymentModelCatalogInput = DeploymentModelCatalogSource & {
  cursor?: string | undefined
  direction?: PaginationDirection | undefined
  limit: number
} & DeploymentModelCatalogFilters

export type DeploymentModelCatalogPage = {
  data: DeploymentModelRecord[]
  meta: PaginationMeta
}

/**
 * The cursor is the sorted pair key, and nothing else: the catalogue is a
 * whole in-memory list ordered by `compareAgentModelOptions`, so a boundary row
 * is all a page needs. It stays base64url-encoded because a cursor is opaque to
 * every client by contract (`PaginationMetaSchema`).
 */
const encodeCursor = (option: Pick<AgentModelOption, 'model' | 'provider'>): string =>
  Buffer.from(modelPairKey(option.provider, option.model), 'utf8').toString('base64url')

const decodeCursor = (cursor: string | undefined): string | null => {
  if (!cursor) return null
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8')
    return decoded.includes(MODEL_PAIR_SEPARATOR) ? decoded : null
  } catch {
    return null
  }
}

/**
 * The filters intentionally apply to Ledger's identifiers before pagination.
 * A local `inference_models` row can describe a withdrawn pair, so filtering
 * it would give an owner a stale and incomplete answer.
 */
export const filterDeploymentModelCatalogue = (
  catalogue: AgentModelOption[],
  filters: DeploymentModelCatalogFilters,
): AgentModelOption[] => {
  const modelNeedle = filters.model?.toLocaleLowerCase()
  const providerNeedle = filters.provider?.toLocaleLowerCase()
  return catalogue.filter((option) =>
    (providerNeedle === undefined
      || option.provider.toLocaleLowerCase().includes(providerNeedle)
      || option.providerDisplayName.toLocaleLowerCase().includes(providerNeedle))
    && (modelNeedle === undefined || option.model.toLocaleLowerCase().includes(modelNeedle)),
  )
}

/**
 * How many agents are pinned to each provider/model pair right now.
 *
 * `deletedAt: null` is load-bearing, not hygiene. `Agent` is soft-deleted, and
 * the count exists so an owner can tell "switching this off strands three
 * agents" from "nobody uses it" — a number inflated by agents somebody already
 * deleted answers neither question, and it is the one number on this page a
 * person acts on.
 */
const loadAgentPinCounts = async (
  prisma: PrismaClient,
  organizationId: string,
): Promise<Map<string, number>> => {
  const grouped = await prisma.agent.groupBy({
    _count: { _all: true },
    by: ['provider', 'model'],
    where: {
      deletedAt: null,
      model: { not: null },
      organizationId,
      provider: { not: null },
    },
  })
  const counts = new Map<string, number>()
  for (const row of grouped) {
    if (!row.provider || !row.model) continue
    counts.set(modelPairKey(row.provider, row.model), row._count._all)
  }
  return counts
}

/** Every local decision for this organisation, keyed by pair. */
const loadLocalDecisions = async (
  prisma: PrismaClient,
  organizationId: string,
): Promise<Map<string, boolean>> => {
  const rows = await prisma.inferenceModel.findMany({
    select: { enabled: true, model: true, provider: { select: { providerKey: true } } },
    where: { organizationId },
  })
  return new Map(
    rows.map((row) => [modelPairKey(row.provider.providerKey, row.model), row.enabled]),
  )
}

export const listDeploymentModelCatalog = async (
  prisma: PrismaClient,
  input: DeploymentModelCatalogInput,
): Promise<DeploymentModelCatalogPage> => {
  const [catalogue, decisions, pins] = await Promise.all([
    listLedgerAgentModels({
      config: input.config,
      ...(input.ledgerPublicUrl ? { ledgerPublicUrl: input.ledgerPublicUrl } : {}),
      ...(input.requestHeaders ? { requestHeaders: input.requestHeaders } : {}),
    }),
    loadLocalDecisions(prisma, input.organizationId),
    loadAgentPinCounts(prisma, input.organizationId),
  ])

  const filteredCatalogue = filterDeploymentModelCatalogue(catalogue, input)
  const boundary = decodeCursor(input.cursor)
  const boundaryIndex = boundary === null
    ? -1
    : filteredCatalogue.findIndex((option) => modelPairKey(option.provider, option.model) === boundary)
  const backward = input.direction === 'backward' && boundaryIndex >= 0

  const start = backward
    ? Math.max(0, boundaryIndex - input.limit)
    : boundaryIndex + 1
  const slice = filteredCatalogue.slice(start, start + input.limit)

  const data = slice.map((option) => {
    const key = modelPairKey(option.provider, option.model)
    const decision = decisions.get(key)
    return {
      agentCount: pins.get(key) ?? 0,
      ...(option.description ? { description: option.description } : {}),
      displayName: option.displayName,
      enabled: decision ?? true,
      hasLocalDecision: decision !== undefined,
      model: option.model,
      provider: option.provider,
      providerDisplayName: option.providerDisplayName,
    }
  })

  const first = slice.at(0)
  const last = slice.at(-1)
  const end = start + slice.length

  return {
    data,
    meta: {
      hasMore: end < filteredCatalogue.length,
      nextCursor: end < filteredCatalogue.length && last ? encodeCursor(last) : null,
      prevCursor: start > 0 && first ? encodeCursor(first) : null,
      total: filteredCatalogue.length,
    },
  }
}

export const DEPLOYMENT_MODEL_ERROR_CODES = {
  NOT_IN_CATALOGUE: 'DEPLOYMENT_MODEL_NOT_IN_CATALOGUE',
} as const

export class DeploymentModelError extends Error {
  override readonly name = 'DeploymentModelError'

  constructor(readonly code: string, message: string) {
    super(message)
  }
}

const findCatalogueOption = async (
  input: DeploymentModelCatalogSource & { model: string; provider: string },
): Promise<AgentModelOption> => {
  const catalogue = await listLedgerAgentModels({
    config: input.config,
    ...(input.ledgerPublicUrl ? { ledgerPublicUrl: input.ledgerPublicUrl } : {}),
    ...(input.requestHeaders ? { requestHeaders: input.requestHeaders } : {}),
  })
  const option = catalogue.find(
    (entry) => entry.provider === input.provider && entry.model === input.model,
  )
  if (!option) {
    throw new DeploymentModelError(
      DEPLOYMENT_MODEL_ERROR_CODES.NOT_IN_CATALOGUE,
      'That provider and model are not in this deployment’s Ledger catalogue.',
    )
  }
  return option
}

/**
 * The container row for a Ledger service id.
 *
 * Created `draft` + disabled deliberately: the worker treats an approved,
 * enabled provider row as an organisation-level routing override, and this page
 * governs availability, not routing. A container that could redirect a run
 * would be a second meaning on the same column.
 */
const upsertProviderContainer = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  option: AgentModelOption,
): Promise<{ id: string; providerKey: string }> => {
  const organizationId = actorContext.tenant.organizationId
  const existing = await prisma.inferenceProvider.findFirst({
    select: { id: true, providerKey: true },
    where: { organizationId, providerKey: option.provider },
  })
  if (existing) return existing

  return prisma.inferenceProvider.create({
    data: {
      connectorKind: 'compiled',
      createdByActorId: actorContext.actor.actorId,
      displayName: option.providerDisplayName,
      enabled: false,
      healthStatus: 'unknown',
      lifecycleStatus: 'draft',
      organizationId,
      providerKey: option.provider,
      supportsModelDiscovery: true,
      updatedByActorId: actorContext.actor.actorId,
    },
    select: { id: true, providerKey: true },
  })
}

/**
 * Ledger tells us a pair exists and what it is called; it does not publish a
 * capability profile in the `/v1/models` listing. The snapshot is therefore
 * recorded as `static` with the conservative shape the runtime already assumes
 * for a Ledger chat model, and the capability catalogue remains the authority
 * at run time — this column is not read by any dispatch path for these rows.
 */
const catalogueSnapshot = (option: AgentModelOption, discoveredAt: string) => ({
  discoveredAt,
  displayName: option.displayName,
  model: option.model,
  provider: option.provider,
  source: 'static' as const,
  structuredOutputMode: 'native-json' as const,
  supportsChat: true,
  supportsEmbeddings: false,
  supportsModelDiscovery: true,
  supportsStreaming: true,
  supportsVision: false,
  systemPromptMode: 'native' as const,
  toolCallingMode: 'native' as const,
  toolResultMode: 'native-tool-message' as const,
  usageReporting: {
    cacheReadTokens: false,
    cacheWriteTokens: false,
    cachedInputTokens: false,
    cachedOutputTokens: false,
    inputTokens: true,
    outputTokens: true,
    providerReportedCost: false,
  },
})

/**
 * Persist a set of decisions as one unit. The catalogue is read and scoped
 * before this runs, so the database transaction has one simple responsibility:
 * create only inert provider containers and upsert every requested pair.
 */
const writeDeploymentModelDecisions = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  options: AgentModelOption[],
  enabled: boolean,
): Promise<void> => {
  if (options.length === 0) return

  const organizationId = actorContext.tenant.organizationId
  const now = new Date()

  await prisma.$transaction(async (transaction) => {
    const tx = transaction as unknown as PrismaClient
    const providers = new Map<string, { id: string; providerKey: string }>()

    for (const option of options) {
      let provider = providers.get(option.provider)
      if (!provider) {
        // This only creates `draft` + disabled containers. In particular, it
        // never changes an existing provider's routing configuration.
        provider = await upsertProviderContainer(tx, actorContext, option)
        providers.set(option.provider, provider)
      }

      await tx.inferenceModel.upsert({
        create: {
          capabilitySnapshot: asJsonValue(catalogueSnapshot(option, now.toISOString())),
          createdByActorId: actorContext.actor.actorId,
          discoveredAt: now,
          displayName: option.displayName,
          enabled,
          lifecycleStatus: 'draft',
          model: option.model,
          organizationId,
          providerId: provider.id,
          source: 'static',
          updatedByActorId: actorContext.actor.actorId,
        },
        update: {
          enabled,
          lastVerifiedAt: now,
          updatedByActorId: actorContext.actor.actorId,
        },
        where: { providerId_model: { model: option.model, providerId: provider.id } },
      })
    }
  }, {
    // A Ledger deployment can legitimately offer hundreds of models (the
    // owner action writes one provider/model uniqueness upsert per pair).
    // Prisma defaults an interactive transaction to five seconds, which can
    // expire halfway through a 687-pair catalogue even on a healthy database.
    maxWait: 5_000,
    timeout: 60_000,
  })
}

export const setDeploymentModelEnabled = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: DeploymentModelCatalogSource & {
    enabled: boolean
    model: string
    provider: string
  },
): Promise<DeploymentModelRecord> => {
  const option = await findCatalogueOption(input)
  const organizationId = actorContext.tenant.organizationId
  await writeDeploymentModelDecisions(prisma, actorContext, [option], input.enabled)

  const pins = await loadAgentPinCounts(prisma, organizationId)
  return {
    agentCount: pins.get(modelPairKey(option.provider, option.model)) ?? 0,
    ...(option.description ? { description: option.description } : {}),
    displayName: option.displayName,
    enabled: input.enabled,
    hasLocalDecision: true,
    model: option.model,
    provider: option.provider,
    providerDisplayName: option.providerDisplayName,
  }
}

export const setDeploymentModelsEnabled = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: DeploymentModelCatalogSource & DeploymentModelCatalogFilters & { enabled: boolean },
): Promise<SetDeploymentModelsEnabledResult> => {
  // Deliberately fetch once and use that same live result to scope every
  // write. `limit`/cursor do not exist here, so this is the whole matching
  // catalogue rather than whichever page the owner happens to be viewing.
  const catalogue = await listLedgerAgentModels({
    config: input.config,
    ...(input.ledgerPublicUrl ? { ledgerPublicUrl: input.ledgerPublicUrl } : {}),
    ...(input.requestHeaders ? { requestHeaders: input.requestHeaders } : {}),
  })
  const options = filterDeploymentModelCatalogue(catalogue, input)
  await writeDeploymentModelDecisions(prisma, actorContext, options, input.enabled)
  return { enabled: input.enabled, updatedCount: options.length }
}

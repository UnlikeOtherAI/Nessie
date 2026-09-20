import type { AgentModelOption } from '@nessie/schemas'
import type { AuthorizedActionContext, PaginationDirection, PaginationMeta } from '@nessie/schemas'
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
import {
  filterDeploymentModelCatalogue,
  type DeploymentModelCatalogSource,
} from './inference-model-catalog.js'
import { type PrismaClient } from './inference-control-plane-core.js'
import {
  isModelPairDisabled,
  loadDisabledModelPairs,
  loadTeamModelAvailabilityDecisions,
} from '@nessie/team-admin'

export type TeamModelCatalogInput = DeploymentModelCatalogSource & {
  cursor?: string | undefined
  direction?: PaginationDirection | undefined
  limit: number
  teamId: string
} & DeploymentModelCatalogFilters

export type TeamModelCatalogPage = {
  data: DeploymentModelRecord[]
  meta: PaginationMeta
}

export const TEAM_MODEL_CATALOG_ERROR_CODES = {
  DISABLED_BY_ORGANIZATION: 'TEAM_MODEL_DISABLED_BY_ORGANIZATION',
  NOT_IN_CATALOGUE: 'TEAM_MODEL_NOT_IN_CATALOGUE',
  TEAM_NOT_FOUND: 'TEAM_MODEL_CATALOG_TEAM_NOT_FOUND',
} as const

export class TeamModelCatalogError extends Error {
  override readonly name = 'TeamModelCatalogError'

  constructor(readonly code: string, message: string) {
    super(message)
  }
}

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

const assertTeamInOrganization = async (
  prisma: PrismaClient,
  organizationId: string,
  teamId: string,
): Promise<void> => {
  const team = await prisma.team.findFirst({
    select: { id: true },
    // Project.teamId is the forward ownership edge. Team.projectId is the
    // legacy inverted relation and must not gain another authorization use.
    where: { id: teamId, projects: { some: { organizationId } } },
  })
  if (!team) {
    throw new TeamModelCatalogError(
      TEAM_MODEL_CATALOG_ERROR_CODES.TEAM_NOT_FOUND,
      'Team not found in this organization.',
    )
  }
}

const loadAgentPinCounts = async (
  prisma: PrismaClient,
  organizationId: string,
  teamId: string,
): Promise<Map<string, number>> => {
  const grouped = await prisma.agent.groupBy({
    _count: { _all: true },
    by: ['provider', 'model'],
    where: {
      deletedAt: null,
      model: { not: null },
      organizationId,
      provider: { not: null },
      teamId,
    },
  })
  const counts = new Map<string, number>()
  for (const row of grouped) {
    if (!row.provider || !row.model) continue
    counts.set(modelPairKey(row.provider, row.model), row._count._all)
  }
  return counts
}

const listEligibleCatalogue = async (
  prisma: PrismaClient,
  input: TeamModelCatalogInput,
): Promise<AgentModelOption[]> => {
  const [catalogue, organizationDisabled] = await Promise.all([
    listLedgerAgentModels({
      config: input.config,
      ...(input.ledgerPublicUrl ? { ledgerPublicUrl: input.ledgerPublicUrl } : {}),
      ...(input.requestHeaders ? { requestHeaders: input.requestHeaders } : {}),
    }),
    loadDisabledModelPairs(prisma, input.organizationId),
  ])
  return filterDeploymentModelCatalogue(
    catalogue.filter((option) =>
      !isModelPairDisabled(organizationDisabled, option.provider, option.model)),
    input,
  )
}

export const listTeamModelCatalog = async (
  prisma: PrismaClient,
  input: TeamModelCatalogInput,
): Promise<TeamModelCatalogPage> => {
  await assertTeamInOrganization(prisma, input.organizationId, input.teamId)
  const [catalogue, decisions, pins] = await Promise.all([
    listEligibleCatalogue(prisma, input),
    loadTeamModelAvailabilityDecisions(prisma, input.teamId),
    loadAgentPinCounts(prisma, input.organizationId, input.teamId),
  ])

  const boundary = decodeCursor(input.cursor)
  const boundaryIndex = boundary === null
    ? -1
    : catalogue.findIndex((option) => modelPairKey(option.provider, option.model) === boundary)
  const backward = input.direction === 'backward' && boundaryIndex >= 0
  const start = backward ? Math.max(0, boundaryIndex - input.limit) : boundaryIndex + 1
  const slice = catalogue.slice(start, start + input.limit)

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
      hasMore: end < catalogue.length,
      nextCursor: end < catalogue.length && last ? encodeCursor(last) : null,
      prevCursor: start > 0 && first ? encodeCursor(first) : null,
      total: catalogue.length,
    },
  }
}

const writeTeamDecisions = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  teamId: string,
  options: AgentModelOption[],
  enabled: boolean,
): Promise<void> => {
  if (options.length === 0) return
  await prisma.$transaction(async (transaction) => {
    const tx = transaction as unknown as PrismaClient
    for (const option of options) {
      await tx.teamInferenceModelAvailability.upsert({
        create: {
          createdByActorId: actorContext.actor.actorId,
          enabled,
          model: option.model,
          provider: option.provider,
          teamId,
          updatedByActorId: actorContext.actor.actorId,
        },
        update: { enabled, updatedByActorId: actorContext.actor.actorId },
        where: {
          teamId_provider_model: {
            model: option.model,
            provider: option.provider,
            teamId,
          },
        },
      })
    }
  }, { maxWait: 5_000, timeout: 60_000 })
}

export const setTeamModelEnabled = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: DeploymentModelCatalogSource & { enabled: boolean; model: string; provider: string; teamId: string },
): Promise<DeploymentModelRecord> => {
  await assertTeamInOrganization(prisma, input.organizationId, input.teamId)
  const catalogue = await listEligibleCatalogue(prisma, { ...input, limit: 1 })
  const option = catalogue.find(
    (entry) => entry.provider === input.provider && entry.model === input.model,
  )
  if (!option) {
    const organizationDisabled = await loadDisabledModelPairs(prisma, input.organizationId)
    if (isModelPairDisabled(organizationDisabled, input.provider, input.model)) {
      throw new TeamModelCatalogError(
        TEAM_MODEL_CATALOG_ERROR_CODES.DISABLED_BY_ORGANIZATION,
        'That model is switched off for this organization and cannot be enabled by a team.',
      )
    }
    throw new TeamModelCatalogError(
      TEAM_MODEL_CATALOG_ERROR_CODES.NOT_IN_CATALOGUE,
      'That provider and model are not in this deployment’s Ledger catalogue.',
    )
  }
  await writeTeamDecisions(prisma, actorContext, input.teamId, [option], input.enabled)
  const pins = await loadAgentPinCounts(prisma, input.organizationId, input.teamId)
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

export const setTeamModelsEnabled = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: TeamModelCatalogInput & { enabled: boolean },
): Promise<SetDeploymentModelsEnabledResult> => {
  await assertTeamInOrganization(prisma, input.organizationId, input.teamId)
  const options = await listEligibleCatalogue(prisma, input)
  await writeTeamDecisions(prisma, actorContext, input.teamId, options, input.enabled)
  return { enabled: input.enabled, updatedCount: options.length }
}

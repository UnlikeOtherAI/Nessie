import type { Prisma } from '@prisma/client'
import { KnowledgeConflictError } from './errors.js'
import type {
  KnowledgePageVersionBasisScope,
  KnowledgePageVersionDisclosureInput,
  KnowledgePageVersionDisclosureSource,
} from './types.js'

type VersionDisclosure = Required<KnowledgePageVersionDisclosureInput>

const DISCLOSURE_SCOPE_TYPES = new Set([
  'agent',
  'channel',
  'organization',
  'project',
  'team',
  'user',
])

const scopeKey = (scope: KnowledgePageVersionBasisScope): string =>
  `${scope.scopeType}:${scope.scopeId}`

const sourceKey = (source: KnowledgePageVersionDisclosureSource): string =>
  `${source.sourceChannelId}:${source.sourceAuthorUserId ?? '__unknown__'}`

const uniqueBy = <T>(items: readonly T[], keyOf: (item: T) => string): T[] => {
  const result = new Map<string, T>()
  for (const item of items) result.set(keyOf(item), item)
  return [...result.values()]
}

/**
 * A successor version may add restrictions from its current run but cannot
 * discard the source boundary of the version it replaces. The caller supplies
 * only version-local facts; this function has no opinion about the page home.
 */
export const mergeVersionDisclosure = (
  inherited: KnowledgePageVersionDisclosureInput | undefined,
  incoming: KnowledgePageVersionDisclosureInput | undefined,
): VersionDisclosure => ({
  basisScopes: uniqueBy(
    [...(inherited?.basisScopes ?? []), ...(incoming?.basisScopes ?? [])],
    scopeKey,
  ),
  disclosureSources: uniqueBy(
    [...(inherited?.disclosureSources ?? []), ...(incoming?.disclosureSources ?? [])],
    sourceKey,
  ),
})

/** Persist source scope and original-author lineage with the immutable version. */
export const persistVersionDisclosure = async (
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string
    versionId: string
    disclosure: KnowledgePageVersionDisclosureInput | undefined
  },
): Promise<void> => {
  const disclosure = mergeVersionDisclosure(undefined, input.disclosure)
  const scopesByType = new Map<string, string[]>()
  for (const scope of disclosure.basisScopes) {
    if (!DISCLOSURE_SCOPE_TYPES.has(scope.scopeType)) {
      throw new KnowledgeConflictError(`Unknown document disclosure scope type: ${scope.scopeType}`)
    }
    scopesByType.set(scope.scopeType, [...(scopesByType.get(scope.scopeType) ?? []), scope.scopeId])
  }
  const idsFor = (scopeType: string): string[] => [...new Set(scopesByType.get(scopeType) ?? [])]
  if (idsFor('organization').some((scopeId) => scopeId !== input.organizationId)) {
    throw new KnowledgeConflictError('A document disclosure organization scope is outside this organization.')
  }
  const [channels, projects, teams, agents, users] = await Promise.all([
    idsFor('channel').length > 0
      ? tx.channel.findMany({
        where: { id: { in: idsFor('channel') }, organizationId: input.organizationId },
        select: { id: true },
      })
      : Promise.resolve([]),
    idsFor('project').length > 0
      ? tx.project.findMany({
        where: { id: { in: idsFor('project') }, organizationId: input.organizationId },
        select: { id: true },
      })
      : Promise.resolve([]),
    idsFor('team').length > 0
      ? tx.team.findMany({
        where: { id: { in: idsFor('team') }, project: { organizationId: input.organizationId } },
        select: { id: true },
      })
      : Promise.resolve([]),
    idsFor('agent').length > 0
      ? tx.agent.findMany({
        where: { id: { in: idsFor('agent') }, organizationId: input.organizationId },
        select: { id: true },
      })
      : Promise.resolve([]),
    idsFor('user').length > 0
      ? tx.user.findMany({ where: { id: { in: idsFor('user') } }, select: { id: true } })
      : Promise.resolve([]),
  ])
  const validateScopeIds = (scopeType: string, rows: readonly { id: string }[]): void => {
    if (rows.length !== idsFor(scopeType).length) {
      throw new KnowledgeConflictError(`A document disclosure ${scopeType} scope is invalid.`)
    }
  }
  validateScopeIds('channel', channels)
  validateScopeIds('project', projects)
  validateScopeIds('team', teams)
  validateScopeIds('agent', agents)
  validateScopeIds('user', users)
  const channelScopeIds = new Set(
    disclosure.basisScopes
      .filter((scope) => scope.scopeType === 'channel')
      .map((scope) => scope.scopeId),
  )
  for (const source of disclosure.disclosureSources) {
    if (!channelScopeIds.has(source.sourceChannelId)) {
      throw new KnowledgeConflictError(
        'A private-conversation source must retain its matching channel basis.',
      )
    }
  }
  if (disclosure.disclosureSources.length > 0) {
    const channelIds = [...new Set(disclosure.disclosureSources.map((source) => source.sourceChannelId))]
    if (channels.filter((channel) => channelIds.includes(channel.id)).length !== channelIds.length) {
      throw new KnowledgeConflictError('A private-conversation source channel is outside this organization.')
    }
    for (const source of disclosure.disclosureSources) {
      if (!source.sourceAuthorUserId) continue
      const [rawHumanTurn, inheritedLineage] = await Promise.all([
        tx.message.findFirst({
          where: {
            agentId: null,
            onBehalfOfUserId: null,
            role: 'user',
            thread: { channel: { id: source.sourceChannelId, organizationId: input.organizationId } },
            userId: source.sourceAuthorUserId,
          },
          select: { id: true },
        }),
        tx.messageDisclosureSource.findFirst({
          where: {
            organizationId: input.organizationId,
            sourceAuthorUserId: source.sourceAuthorUserId,
            sourceChannelId: source.sourceChannelId,
          },
          select: { id: true },
        }),
      ])
      if (!rawHumanTurn && !inheritedLineage) {
        throw new KnowledgeConflictError('A document source author has no canonical source conversation lineage.')
      }
    }
  }
  if (disclosure.basisScopes.length > 0) {
    await tx.knowledgePageVersionBasisScope.createMany({
      data: disclosure.basisScopes.map((scope) => ({
        organizationId: input.organizationId,
        scopeId: scope.scopeId,
        scopeType: scope.scopeType,
        versionId: input.versionId,
      })),
      skipDuplicates: true,
    })
  }
  if (disclosure.disclosureSources.length > 0) {
    await tx.knowledgePageVersionDisclosureSource.createMany({
      data: disclosure.disclosureSources.map((source) => ({
        organizationId: input.organizationId,
        sourceAuthorUserId: source.sourceAuthorUserId,
        sourceChannelId: source.sourceChannelId,
        versionId: input.versionId,
      })),
      skipDuplicates: true,
    })
  }
}

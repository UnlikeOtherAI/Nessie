import { Prisma, type PrismaClient } from '@prisma/client'
import type { ContainerDescription } from '@nessie/board-sources'
import {
  type BoardSourceDetailRecord,
  type BoardSourceFieldMapping,
  type BoardSourceProvider,
  type BoardSourceRecord,
  type BoardSourceStateMapping,
  type BoardSourceWriteMode,
  parseProjectId,
  parseUserId,
} from '@nessie/schemas'

import { parseFieldMappings, parseStateMapping } from './board-source-apply.js'

/**
 * Board sources as the API manages them: attach, describe, map, pause, remove.
 *
 * Kept out of the route module because the personal assistant does not manage
 * sources today but the write-back path and the worker both need the mapping
 * reads, and a second copy of "what does this source's mapping say" is exactly
 * the fork Rule zero names.
 */

export type BoardSourceError =
  | { error: 'SOURCE_NOT_FOUND' }
  | { error: 'CONNECTION_NOT_FOUND' }
  | { error: 'CONNECTION_NOT_OWNED' }
  | { error: 'CONTAINER_ALREADY_ATTACHED' }
  | { error: 'CONNECTION_IN_USE'; detail: string }

export const isBoardSourceError = <T>(value: T | BoardSourceError): value is BoardSourceError =>
  typeof value === 'object' && value !== null && 'error' in value

const sourceInclude = {
  connection: {
    select: {
      ownerUserId: true,
      // Carried because it is the identity-mapping tenant for providers whose
      // tenant is the workspace rather than the container (Linear).
      externalTenantId: true,
      owner: { select: { displayName: true } },
    },
  },
  _count: { select: { links: true } },
} as const

type SourceRow = Prisma.BoardSourceGetPayload<{ include: typeof sourceInclude }>

export const mapBoardSource = (source: SourceRow): BoardSourceRecord => ({
  id: source.id,
  projectId: parseProjectId(source.projectId),
  connectionId: source.connectionId,
  provider: source.provider,
  name: source.name,
  container: source.container as Record<string, unknown>,
  containerKey: source.containerKey,
  writeMode: source.writeMode,
  syncWindowDays: source.syncWindowDays,
  healthState: source.healthState,
  healthReason: source.healthReason,
  healthDetail: source.healthDetail,
  lastSyncCompletedAt: source.lastSyncCompletedAt?.toISOString() ?? null,
  lastErrorCode: source.lastErrorCode,
  connectionOwnerUserId: parseUserId(source.connection.ownerUserId),
  connectionOwnerDisplayName: source.connection.owner?.displayName ?? null,
  itemCount: source._count.links,
})

export const listBoardSources = async (
  prisma: PrismaClient,
  projectId: string,
): Promise<BoardSourceRecord[]> => {
  const sources = await prisma.boardSource.findMany({
    where: { projectId },
    include: sourceInclude,
    orderBy: { createdAt: 'asc' },
  })
  return sources.map(mapBoardSource)
}

/**
 * One source with everything its mapping page needs: the stored mapping plus
 * the container as last described, so the tables have rows even before a sync.
 */
export const getBoardSourceDetail = async (
  prisma: PrismaClient,
  projectId: string,
  sourceId: string,
  description: ContainerDescription | null,
): Promise<BoardSourceDetailRecord | BoardSourceError> => {
  const source = await prisma.boardSource.findFirst({
    where: { id: sourceId, projectId },
    include: sourceInclude,
  })
  if (!source) return { error: 'SOURCE_NOT_FOUND' }

  const identityLinks = await prisma.boardSourceIdentityLink.findMany({
    where: {
      organizationId: source.organizationId,
      provider: source.provider,
      externalTenantKey: externalTenantKeyFor(source),
    },
    orderBy: { externalDisplayName: 'asc' },
  })

  return {
    ...mapBoardSource(source),
    stateMapping: parseStateMapping(source.stateMapping),
    fieldMappings: parseFieldMappings(source.fieldMappings),
    identityLinks: identityLinks.map((link) => ({
      id: link.id,
      externalUserId: link.externalUserId,
      externalDisplayName: link.externalDisplayName,
      userId: link.userId ? parseUserId(link.userId) : null,
      agentId: link.agentId ? (link.agentId as BoardSourceDetailRecord['identityLinks'][number]['agentId']) : null,
      matchedBy: link.matchedBy === 'email' ? 'email' : 'manual',
    })),
    states: (description?.states ?? []).map((state) => ({ id: state.id, name: state.name })),
    fields: (description?.fields ?? []).map((field) => ({
      key: field.key,
      label: field.label,
      type: field.type,
    })),
    members: (description?.members ?? []).map((member) => ({
      externalUserId: member.externalUserId,
      displayName: member.displayName,
      ...(member.email ? { email: member.email } : {}),
    })),
  }
}

export const externalTenantKeyFor = (source: {
  provider: BoardSourceProvider
  container: unknown
  connection?: { externalTenantId?: string }
}): string => {
  const container = (source.container ?? {}) as Record<string, unknown>
  if (source.provider === 'jira') return String(container.cloudId ?? '')
  if (source.provider === 'linear') return source.connection?.externalTenantId ?? ''
  return source.provider
}

/**
 * Attach a container to a project. Seeds the mapping from the adapter's own
 * description so the first sync is right without anybody configuring anything:
 * every state lands where the provider's own classification says, and `review`
 * starts empty because a state's *name* is not evidence of its meaning.
 */
export const createBoardSource = async (
  prisma: PrismaClient,
  input: {
    projectId: string
    organizationId: string
    connectionId: string
    provider: BoardSourceProvider
    container: Record<string, unknown>
    containerKey: string
    name: string
    createdByUserId: string
    description: ContainerDescription
    /** Definition ids created for this source's external fields, by field key. */
    fieldTargets: Record<string, string>
  },
): Promise<BoardSourceRecord | BoardSourceError> => {
  const connection = await prisma.boardSourceConnection.findFirst({
    where: { id: input.connectionId, organizationId: input.organizationId },
    select: { id: true, ownerUserId: true, provider: true },
  })
  if (!connection || connection.provider !== input.provider) {
    return { error: 'CONNECTION_NOT_FOUND' }
  }
  // A source runs on one person's delegated authority, so only that person may
  // point it at a project: attaching somebody else's connection would sync
  // under a credential its owner never aimed here.
  if (connection.ownerUserId !== input.createdByUserId) {
    return { error: 'CONNECTION_NOT_OWNED' }
  }

  const clash = await prisma.boardSource.count({
    where: {
      projectId: input.projectId,
      provider: input.provider,
      containerKey: input.containerKey,
    },
  })
  if (clash > 0) return { error: 'CONTAINER_ALREADY_ATTACHED' }

  const stateMapping = seedStateMapping(input.description)
  const fieldMappings = seedFieldMappings(input.description, input.fieldTargets)

  const source = await prisma.boardSource.create({
    data: {
      projectId: input.projectId,
      organizationId: input.organizationId,
      connectionId: input.connectionId,
      provider: input.provider,
      name: input.name,
      container: input.container as Prisma.InputJsonValue,
      containerKey: input.containerKey,
      stateMapping: stateMapping as unknown as Prisma.InputJsonValue,
      fieldMappings: fieldMappings as unknown as Prisma.InputJsonValue,
      createdByUserId: input.createdByUserId,
      // Sync starts as soon as the sweep next runs.
      nextRunAt: new Date(),
      checkpoint: { phase: 'initial' },
    },
    include: sourceInclude,
  })
  return mapBoardSource(source)
}

export const seedStateMapping = (
  description: ContainerDescription,
): BoardSourceStateMapping[] => {
  const seenDefault = new Set<string>()
  return description.states.map((state) => {
    const category = state.suggestedCategory ?? null
    const isDefaultForCategory =
      category !== null && category !== 'archived' && !seenDefault.has(category)
    if (isDefaultForCategory) seenDefault.add(category)
    return {
      externalStateId: state.id,
      externalStateName: state.name,
      category,
      isDefaultForCategory,
    }
  })
}

export const seedFieldMappings = (
  description: ContainerDescription,
  fieldTargets: Record<string, string>,
): BoardSourceFieldMapping[] =>
  description.fields.flatMap((field) => {
    const target = fieldTargets[field.key]
    if (!target) return []
    return [{ externalKey: field.key, externalLabel: field.label, target }]
  })

export const updateBoardSource = async (
  prisma: PrismaClient,
  projectId: string,
  sourceId: string,
  input: {
    name?: string
    writeMode?: BoardSourceWriteMode
    syncWindowDays?: number
    connectionId?: string
    actorUserId: string
  },
): Promise<BoardSourceRecord | BoardSourceError> => {
  const existing = await prisma.boardSource.findFirst({
    where: { id: sourceId, projectId },
    select: { id: true, organizationId: true, provider: true },
  })
  if (!existing) return { error: 'SOURCE_NOT_FOUND' }

  if (input.connectionId) {
    const connection = await prisma.boardSourceConnection.findFirst({
      where: { id: input.connectionId, organizationId: existing.organizationId },
      select: { ownerUserId: true, provider: true },
    })
    if (!connection || connection.provider !== existing.provider) {
      return { error: 'CONNECTION_NOT_FOUND' }
    }
    // The same rule as attaching: re-pointing a source is the "connect as me"
    // remedy, so the caller must be the new connection's owner.
    if (connection.ownerUserId !== input.actorUserId) return { error: 'CONNECTION_NOT_OWNED' }
  }

  const source = await prisma.boardSource.update({
    where: { id: sourceId },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.writeMode !== undefined ? { writeMode: input.writeMode } : {}),
      ...(input.syncWindowDays !== undefined ? { syncWindowDays: input.syncWindowDays } : {}),
      ...(input.connectionId !== undefined
        ? {
            connectionId: input.connectionId,
            healthState: 'active' as const,
            healthReason: null,
            nextRunAt: new Date(),
          }
        : {}),
    },
    include: sourceInclude,
  })
  return mapBoardSource(source)
}

/**
 * Remove a source. Its tasks stay in the project as ordinary tasks and simply
 * stop updating — deleting somebody's work because an integration was removed
 * would be the wrong answer to "I no longer want this connected".
 */
export const deleteBoardSource = async (
  prisma: PrismaClient,
  projectId: string,
  sourceId: string,
): Promise<{ ok: true } | BoardSourceError> => {
  const result = await prisma.boardSource.deleteMany({ where: { id: sourceId, projectId } })
  return result.count > 0 ? { ok: true } : { error: 'SOURCE_NOT_FOUND' }
}

export const putBoardSourceMappings = async (
  prisma: PrismaClient,
  projectId: string,
  sourceId: string,
  input: {
    stateMapping: BoardSourceStateMapping[]
    fieldMappings: BoardSourceFieldMapping[]
    identityLinks: {
      externalUserId: string
      externalDisplayName?: string | null
      userId?: string | null
      agentId?: string | null
    }[]
    actorUserId: string
  },
): Promise<BoardSourceRecord | BoardSourceError> => {
  const source = await prisma.boardSource.findFirst({
    where: { id: sourceId, projectId },
    include: { connection: { select: { externalTenantId: true } } },
  })
  if (!source) return { error: 'SOURCE_NOT_FOUND' }
  const tenantKey = externalTenantKeyFor(source)

  const updated = await prisma.$transaction(async (tx) => {
    for (const link of input.identityLinks) {
      const data = {
        externalDisplayName: link.externalDisplayName ?? null,
        userId: link.userId ?? null,
        agentId: link.agentId ?? null,
        matchedBy: 'manual',
        createdByUserId: input.actorUserId,
      }
      await tx.boardSourceIdentityLink.upsert({
        where: {
          organizationId_provider_externalTenantKey_externalUserId: {
            organizationId: source.organizationId,
            provider: source.provider,
            externalTenantKey: tenantKey,
            externalUserId: link.externalUserId,
          },
        },
        create: {
          organizationId: source.organizationId,
          provider: source.provider,
          externalTenantKey: tenantKey,
          externalUserId: link.externalUserId,
          ...data,
        },
        update: data,
      })
    }
    return tx.boardSource.update({
      where: { id: sourceId },
      data: {
        stateMapping: input.stateMapping as unknown as Prisma.InputJsonValue,
        fieldMappings: input.fieldMappings as unknown as Prisma.InputJsonValue,
        // A mapping change is exactly what clears `UNMAPPED_STATE`, so the
        // source is re-run rather than left sitting in a state a person fixed.
        healthState: source.healthState === 'misconfigured' ? 'active' : source.healthState,
        healthReason: source.healthState === 'misconfigured' ? null : source.healthReason,
        nextRunAt: new Date(),
      },
      include: sourceInclude,
    })
  })
  return mapBoardSource(updated)
}

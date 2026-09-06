import type { PrismaClient } from '@prisma/client'
import {
  AdapterNotRegisteredError,
  SourceAuthError,
  resolveBoardSourceAdapter,
} from '@nessie/board-sources'

import {
  isBoardSourceCredentialError,
  loadBoardSourceConnectionContext,
} from './board-source-credential.js'

/**
 * Asking the provider itself, live, for items Nessie has not mirrored.
 *
 * The mirror is still the model: §5 rejected live query-through as the way to
 * fill a board and this does not revive it — nothing here is written to a
 * `Task`, and no board reads it. It answers the question the mirror
 * structurally cannot: an item outside the sync window, in a state the mapping
 * drops, or simply newer than the last sweep is invisible locally, and before
 * this the only honest answer was "I cannot see it".
 *
 * Every search runs under a source's own connection — one person's delegated
 * authority, pointed at one container — so it reaches exactly what that
 * person's sync already reaches, and a refusal is theirs to fix.
 */

export type RemoteTicketMatch = {
  sourceId: string
  sourceName: string
  provider: 'jira' | 'linear' | 'trello' | 'github'
  projectId: string
  externalKey: string
  externalUrl: string
  title: string
  stateName: string
  assigneeDisplayName: string | null
  updatedAt: string
  /**
   * The local ticket mirroring this item, when there is one. A search that did
   * not say so would report an item twice — once from here and once from
   * `ticket_search` — and give no way to tell which results can be acted on.
   */
  taskId: string | null
}

export type RemoteTicketSearchOutcome = {
  matches: RemoteTicketMatch[]
  /** Sources that could not be asked, so a thin answer never looks complete. */
  unavailable: { sourceId: string; sourceName: string; reason: string }[]
}

export const REMOTE_SEARCH_LIMIT = 25

const reasonFor = (error: unknown): string => {
  if (typeof error === 'object' && error !== null && 'error' in error) {
    const code = (error as { error: string }).error
    if (code === 'OWNER_INACTIVE') {
      return 'the person who connected it is no longer an active member'
    }
    if (code === 'CONNECTION_NEEDS_REAUTHORIZATION') return 'its connection needs reauthorising'
    return 'its connection is missing'
  }
  if (error instanceof SourceAuthError) return 'the provider rejected the credential'
  // Adapters are registered from the environment, so a deployment can be
  // running without one. That is a configuration answer, not a provider fault.
  if (error instanceof AdapterNotRegisteredError) {
    return 'this deployment has no adapter configured for that provider'
  }
  return error instanceof Error ? error.message : 'the provider could not be reached'
}

/**
 * Search every source on the projects given, and say which ones answered.
 *
 * Sources are asked concurrently and a failure is reported rather than thrown:
 * one unreachable Jira must not withhold what Linear found, but a caller that
 * silently dropped it would present a partial answer as a complete one.
 */
export const searchRemoteTickets = async (
  prisma: PrismaClient,
  input: {
    organizationId: string
    projectIds: string[]
    text: string
    limit?: number
    encryptionSecret: string
  },
): Promise<RemoteTicketSearchOutcome> => {
  if (input.projectIds.length === 0 || !input.text.trim()) {
    return { matches: [], unavailable: [] }
  }
  const limit = Math.min(input.limit ?? REMOTE_SEARCH_LIMIT, REMOTE_SEARCH_LIMIT)

  const sources = await prisma.boardSource.findMany({
    where: {
      organizationId: input.organizationId,
      projectId: { in: input.projectIds },
      // A paused source is one a person deliberately stopped; honouring that
      // here keeps "paused" meaning the same thing everywhere.
      healthState: { not: 'paused' },
    },
    select: {
      id: true,
      name: true,
      provider: true,
      projectId: true,
      connectionId: true,
      container: true,
    },
  })

  const unavailable: RemoteTicketSearchOutcome['unavailable'] = []
  const perSource = await Promise.all(
    sources.map(async (source) => {
      try {
        const ctx = await loadBoardSourceConnectionContext(
          prisma,
          source.connectionId,
          input.encryptionSecret,
        )
        if (isBoardSourceCredentialError(ctx)) {
          unavailable.push({ sourceId: source.id, sourceName: source.name, reason: reasonFor(ctx) })
          return []
        }
        const adapter = resolveBoardSourceAdapter(source.provider)
        const items = await adapter.searchItems(
          ctx,
          source.container as Record<string, unknown>,
          { text: input.text, limit },
        )
        return items.map((item) => ({ source, item }))
      } catch (error) {
        unavailable.push({
          sourceId: source.id,
          sourceName: source.name,
          reason: reasonFor(error),
        })
        return []
      }
    }),
  )

  const found = perSource.flat()
  if (found.length === 0) return { matches: [], unavailable }

  // One read to say which of these Nessie already holds, rather than one per
  // item: the pair is the link's own unique key.
  const links = await prisma.taskExternalLink.findMany({
    where: {
      organizationId: input.organizationId,
      OR: found.map(({ source, item }) => ({
        sourceId: source.id,
        externalId: item.externalId,
      })),
    },
    select: { sourceId: true, externalId: true, taskId: true },
  })
  const taskByLink = new Map(
    links.map((link) => [`${link.sourceId}:${link.externalId}`, link.taskId]),
  )

  const matches = found
    .map(({ source, item }): RemoteTicketMatch => ({
      sourceId: source.id,
      sourceName: source.name,
      provider: source.provider,
      projectId: source.projectId,
      externalKey: item.externalKey,
      externalUrl: item.url,
      title: item.title,
      stateName: item.stateName,
      // The provider's own name for its own user — the same thing the mirror
      // stores when no identity link resolves, and never a Nessie person.
      assigneeDisplayName: item.assignee?.displayName ?? null,
      updatedAt: item.updatedAt,
      taskId: taskByLink.get(`${source.id}:${item.externalId}`) ?? null,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit)

  return { matches, unavailable }
}

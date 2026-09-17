import type { LedgerAttribution } from '@nessie/runtime'

import { invalidRequest } from './errors.js'
import { createSpreadsheetSnapshot } from './snapshot.js'
import { restoreSpreadsheetVersion } from './restore.js'
import type { SpreadsheetRef } from './agent-reads.js'
import type { SpreadsheetServiceDeps, SpreadsheetWriteActor } from './deps.js'

/**
 * Version history, as the tools see it.
 *
 * There is no approval gate on an agent's writes, so this is the surface that
 * makes one safe: an agent that got it wrong can name the version it wants back
 * and say which one it went to, in the same sentence it apologises in. It is
 * deliberately the *same* door the pane's History panel uses — a restore an
 * agent performed and a restore a person clicked have to be the same event, or
 * the two histories tell different stories about the same document.
 *
 * `restoreSpreadsheetVersion` takes its own version of the current state first,
 * so an agent's restore is itself reversible.
 *
 * docs/plans/2026-09-15-spreadsheets-ironcalc/agent-tools.md
 */

export type SpreadsheetVersionSummary = {
  id: string
  number: number
  at: string
  author: { type: string; name: string }
  comment: string | null
  agent?: string
}

const VERSION_PAGE = 50

export const listSpreadsheetVersions = async (
  deps: SpreadsheetServiceDeps,
  input: SpreadsheetRef & { limit?: number },
): Promise<{ versions: SpreadsheetVersionSummary[] }> => {
  const rows = await deps.prisma.knowledgePageVersion.findMany({
    where: { pageId: input.pageId, page: { organizationId: input.organizationId } },
    orderBy: { versionNumber: 'desc' },
    take: Math.min(Math.max(input.limit ?? 20, 1), VERSION_PAGE),
    select: {
      id: true,
      versionNumber: true,
      createdAt: true,
      changeComment: true,
      authorId: true,
      authorType: true,
    },
  })

  const userIds = rows.filter((row) => row.authorType === 'user').map((row) => row.authorId)
  const agentIds = rows.filter((row) => row.authorType === 'agent').map((row) => row.authorId)
  const [users, agents] = await Promise.all([
    userIds.length
      ? deps.prisma.user.findMany({
        where: { id: { in: [...new Set(userIds)] } },
        select: { id: true, displayName: true },
      })
      : [],
    agentIds.length
      ? deps.prisma.agent.findMany({
        where: { id: { in: [...new Set(agentIds)] } },
        select: { id: true, name: true },
      })
      : [],
  ])
  const names = new Map<string, string>([
    ...users.map((user) => [user.id, user.displayName ?? 'Someone'] as const),
    ...agents.map((agent) => [agent.id, agent.name] as const),
  ])

  return {
    versions: rows.map((row) => ({
      id: row.id,
      number: row.versionNumber,
      at: row.createdAt.toISOString(),
      author: {
        type: row.authorType,
        name: names.get(row.authorId) ?? (row.authorType === 'agent' ? 'Agent' : 'Someone'),
      },
      comment: row.changeComment,
      ...(row.authorType === 'agent'
        ? { agent: names.get(row.authorId) ?? 'Agent' }
        : {}),
    })),
  }
}

export type VersionActor = {
  actor: SpreadsheetWriteActor
  attribution: LedgerAttribution
}

export const saveSpreadsheetVersion = async (
  deps: SpreadsheetServiceDeps,
  who: VersionActor,
  input: SpreadsheetRef & { comment?: string | null },
): Promise<{ versionId: string; seq: number; comment: string }> => {
  const comment = (input.comment ?? '').trim()
    || `saved by ${who.actor.displayName}`
  const snapshot = await createSpreadsheetSnapshot(deps, {
    organizationId: input.organizationId,
    pageId: input.pageId,
    actor: who.actor,
    attribution: who.attribution,
    reason: 'named',
    changeComment: comment,
  })
  return { versionId: snapshot.versionId, seq: snapshot.seq, comment }
}

export const restoreSpreadsheetVersionForTool = async (
  deps: SpreadsheetServiceDeps,
  who: VersionActor,
  input: SpreadsheetRef & { versionId?: string | null },
): Promise<{ restoredVersionId: string; previousVersionId: string | null; seq: number }> => {
  const versionId = (input.versionId ?? '').trim()
  if (!versionId) throw invalidRequest('`versionId` says which version to restore')
  const result = await restoreSpreadsheetVersion(deps, {
    organizationId: input.organizationId,
    pageId: input.pageId,
    versionId,
    actor: who.actor,
    attribution: who.attribution,
  })
  return {
    restoredVersionId: versionId,
    previousVersionId: result.previousVersionId,
    seq: result.seq,
  }
}

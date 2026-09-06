import type { PrismaClient } from '@prisma/client'
import {
  type BoardSourceAdapter,
  type NormalisedItem,
  type OutboundChange,
  SourceRejectedError,
  itemFingerprint,
  resolveBoardSourceAdapter,
} from '@nessie/board-sources'
import type { ColumnCategory } from '@nessie/schemas'

import {
  applyInboundItem,
  mappedFieldKeys,
  parseFieldMappings,
  parseStateMapping,
} from './board-source-apply.js'
import {
  isBoardSourceCredentialError,
  loadBoardSourceConnectionContext,
} from './board-source-credential.js'
import { externalTenantKeyFor, loadIdentityLinks } from './board-source-identity.js'

/**
 * Changing a mirrored item where it actually lives.
 *
 * The write happens **inside the person's request**, before the local
 * transaction, and the mirror is then written from the vendor's echo rather
 * than from the request. That is what makes a refusal something a person sees
 * as their drag snapping back with a reason, instead of a toast a minute later
 * contradicting a board they have already moved on from.
 *
 * It also means local and remote cannot diverge on a mapped field by
 * construction: the only way a mapped field changes locally is a write-back
 * that already succeeded, so there is no merge to do.
 */

export type BoardSourceWriteBackError =
  | { error: 'SOURCE_READ_ONLY'; provider: string; detail: string }
  | { error: 'SOURCE_REJECTED'; code: string; detail: string }
  | { error: 'ASSIGNEE_NOT_LINKED'; detail: string }
  | { error: 'SOURCE_UNAVAILABLE'; detail: string }

export const isWriteBackError = <T>(
  value: T | BoardSourceWriteBackError,
): value is BoardSourceWriteBackError =>
  typeof value === 'object' && value !== null && 'error' in value

/**
 * The collaborator the task mutations take. Built identically by the API and
 * the worker from the same registry, so the personal assistant's `ticket_move`
 * gets exactly the refusal a person's drag gets.
 */
export type BoardSourceWriteBack = {
  /**
   * Ask the provider to change one item and apply its echo. Returns null when
   * the task is not mirrored, so a native task costs nothing.
   */
  apply: (input: {
    taskId: string
    change: OutboundChange
    /** The lifecycle category the change moves the item into, when it moves. */
    category?: ColumnCategory
    /** Set when a specific column asked for a specific external state. */
    boundStateId?: string | null
  }) => Promise<{ ok: true } | BoardSourceWriteBackError | null>
}

export type WriteBackDeps = {
  prisma: PrismaClient
  encryptionSecret: string
  resolveAdapter?: (provider: string) => BoardSourceAdapter
}

export const createBoardSourceWriteBack = (deps: WriteBackDeps): BoardSourceWriteBack => ({
  apply: async ({ taskId, change, category, boundStateId }) => {
    const { prisma } = deps
    const link = await prisma.taskExternalLink.findUnique({
      where: { taskId },
      include: {
        source: { include: { connection: { select: { externalTenantId: true } } } },
      },
    })
    // Not mirrored: nothing to write back, and the caller proceeds normally.
    if (!link) return null

    const source = link.source
    const stateMapping = parseStateMapping(source.stateMapping)
    const fieldMappings = parseFieldMappings(source.fieldMappings)

    // Which external state this move asks for: the column's own binding when it
    // has one, else the category's default state.
    let stateId: string | undefined
    if (category) {
      stateId =
        boundStateId ??
        stateMapping.find(
          (entry) => entry.category === category && entry.isDefaultForCategory,
        )?.externalStateId
      if (!stateId) {
        return {
          error: 'SOURCE_REJECTED',
          code: 'NO_DEFAULT_STATE',
          detail: `No ${source.provider} state is mapped as the default for that column. Set one in Settings → Sources.`,
        }
      }
    }

    const outbound: OutboundChange = { ...change, ...(stateId ? { stateId } : {}) }
    if (Object.keys(outbound).length === 0) return { ok: true }

    if (source.writeMode === 'read_only') {
      return {
        error: 'SOURCE_READ_ONLY',
        provider: source.provider,
        detail: `${providerName(source.provider)} owns this ticket. Switch the source to read & write in Settings → Sources to change it from here.`,
      }
    }

    const context = await loadBoardSourceConnectionContext(
      prisma,
      source.connectionId,
      deps.encryptionSecret,
    )
    if (isBoardSourceCredentialError(context)) {
      return {
        error: 'SOURCE_UNAVAILABLE',
        detail: `${providerName(source.provider)} cannot be reached with this source's connection. Reconnect it in Settings → Sources.`,
      }
    }

    const adapter = (deps.resolveAdapter ?? resolveBoardSourceAdapter)(source.provider)
    let echo: NormalisedItem
    try {
      echo = await adapter.applyChange(
        context,
        source.container as Record<string, unknown>,
        { externalId: link.externalId, externalKey: link.externalKey },
        outbound,
      )
    } catch (cause) {
      if (cause instanceof SourceRejectedError) {
        return { error: 'SOURCE_REJECTED', code: cause.code, detail: cause.detail }
      }
      return {
        error: 'SOURCE_UNAVAILABLE',
        detail: `${providerName(source.provider)} could not be reached.`,
      }
    }

    // Stamp the echo's fingerprint before applying it, so the webhook this
    // write triggers is recognised as our own and writes no event.
    await prisma.taskExternalLink.update({
      where: { id: link.id },
      data: {
        outboundFingerprint: itemFingerprint(echo, mappedFieldKeys(fieldMappings)),
        lastOutboundAt: new Date(),
      },
    })
    await applyInboundItem(
      prisma,
      {
        id: source.id,
        organizationId: source.organizationId,
        projectId: source.projectId,
        provider: source.provider,
        stateMapping,
        fieldMappings,
        identityByExternalUserId: await loadIdentityLinks(prisma, {
          organizationId: source.organizationId,
          provider: source.provider,
          externalTenantKey: externalTenantKeyFor(source),
        }),
      },
      echo,
    )
    return { ok: true }
  },
})

const PROVIDER_NAMES: Record<string, string> = {
  jira: 'Jira',
  linear: 'Linear',
  trello: 'Trello',
  github: 'GitHub',
}

const providerName = (provider: string): string => PROVIDER_NAMES[provider] ?? provider

/**
 * The external user id a Nessie assignee writes back as. `null` clears the
 * assignment upstream; a refusal names the remedy, because "it silently did not
 * assign anybody" is the worst of the three outcomes.
 */
export const resolveOutboundAssignee = async (
  prisma: PrismaClient,
  input: {
    organizationId: string
    provider: string
    externalTenantKey: string
    userId: string | null
    agentId: string | null
    displayName: string | null
  },
): Promise<string | null | BoardSourceWriteBackError> => {
  if (!input.userId && !input.agentId) return null
  const link = await prisma.boardSourceIdentityLink.findFirst({
    where: {
      organizationId: input.organizationId,
      provider: input.provider as 'jira' | 'linear' | 'trello' | 'github',
      externalTenantKey: input.externalTenantKey,
      ...(input.userId ? { userId: input.userId } : { agentId: input.agentId }),
    },
    select: { externalUserId: true },
  })
  if (link) return link.externalUserId
  return {
    error: 'ASSIGNEE_NOT_LINKED',
    detail: `${input.displayName ?? 'That assignee'} is not linked to a ${providerName(input.provider)} account. Link them in Settings → Sources → People.`,
  }
}

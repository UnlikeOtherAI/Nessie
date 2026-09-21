import type { PrismaClient } from '@prisma/client'
import {
  type BoardSourceAdapter,
  type NormalisedComment,
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
  mapsNativeLabels,
  parseFieldMappings,
  parseStateMapping,
  syncTaskSourceLabels,
} from './board-source-apply.js'
import { loadStoredAssetUrls, rewriteForProvider } from './board-source-apply-activity.js'
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
  encryptionSecret: import('@nessie/runtime').EncryptionKeyRingInput
  resolveAdapter?: (provider: string) => BoardSourceAdapter
  /**
   * This deployment's public admin origin, when known. A description written
   * back upstream turns a Nessie-born image into an absolute link here — which
   * needs a Nessie sign-in to open (the stated v1 gap) — instead of a relative
   * path the provider cannot resolve at all.
   */
  appOrigin?: string | null
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
    // The description is stored with our own paths for images the sync
    // fetched; upstream gets the provider's URLs back.
    if (typeof outbound.description === 'string') {
      const stored = await loadStoredAssetUrls(prisma, source.id, [taskId])
      outbound.description = rewriteForProvider(
        outbound.description,
        stored.get(taskId) ?? [],
        deps.appOrigin,
      )
    }

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
    // The fingerprint stamped above makes that apply an `echo`, which writes
    // nothing — right for fields the caller then writes itself, but labels are
    // links the caller does not own. The source-owned subset is mirrored from
    // what the provider actually stored, never from what was asked for.
    if (change.labelIds !== undefined && mapsNativeLabels(fieldMappings)) {
      await syncTaskSourceLabels(prisma, source, taskId, echo.labels, { recordEvent: false })
    }
    return { ok: true }
  },
})

/** A comment write-back can also find the adapter cannot edit comments at all. */
export type BoardSourceCommentWriteBackError =
  | BoardSourceWriteBackError
  | { error: 'COMMENT_NOT_WRITABLE'; provider: string; detail: string }

/** What a comment write-back stored upstream: the row is written from this. */
export type CommentEcho = {
  sourceId: string
  externalId: string
  externalUrl: string | null
  externalUpdatedAt: Date
  editedAt: Date | null
  body: string
}

/**
 * Comments on a mirrored ticket (§4.6). The comment service calls this before
 * its own transaction, exactly as the task mutations call `apply`.
 *
 * - `create` answers `{ propagated: false }` when the comment stays in Nessie:
 *   the task is not mirrored, the source is read only (a comment is Nessie's
 *   own conversation about the ticket, not a mapped field), or the provider has
 *   no comment write. Otherwise the provider's echo, which carries the
 *   `externalId` that stops the next sync importing it a second time.
 * - `update`/`remove` answer `null` for a comment that was never upstream, so
 *   the caller edits it locally; an imported comment on a read-only source is
 *   refused `SOURCE_READ_ONLY`, and one whose provider cannot edit comments
 *   `COMMENT_NOT_WRITABLE`.
 */
export type BoardSourceCommentWriteBack = {
  create: (input: { taskId: string; body: string }) => Promise<
    | { propagated: true; echo: CommentEcho }
    | { propagated: false; reason: 'not_mirrored' | 'read_only' | 'unsupported' }
    | BoardSourceCommentWriteBackError
  >
  update: (input: { commentId: string; body: string }) => Promise<
    { ok: true; echo: CommentEcho } | BoardSourceCommentWriteBackError | null
  >
  remove: (input: { commentId: string }) => Promise<
    { ok: true } | BoardSourceCommentWriteBackError | null
  >
}

const commentEcho = (sourceId: string, echo: NormalisedComment): CommentEcho => ({
  sourceId,
  externalId: echo.externalId,
  externalUrl: echo.url ?? null,
  externalUpdatedAt: new Date(echo.updatedAt),
  editedAt: echo.editedAt ? new Date(echo.editedAt) : null,
  body: echo.body,
})

type CommentSourceRow = {
  id: string
  provider: import('@nessie/board-sources').BoardSourceProvider
  connectionId: string
  writeMode: string
  container: unknown
}

export const createBoardSourceCommentWriteBack = (
  deps: WriteBackDeps,
): BoardSourceCommentWriteBack => {
  const { prisma } = deps
  const resolveAdapter = deps.resolveAdapter ?? resolveBoardSourceAdapter

  /** The adapter and credential for one write, or the refusal a person sees. */
  const prepare = async (
    source: CommentSourceRow,
  ): Promise<
    | { adapter: BoardSourceAdapter; context: import('@nessie/board-sources').ConnectionContext }
    | BoardSourceCommentWriteBackError
  > => {
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
    return { adapter: resolveAdapter(source.provider), context }
  }

  const readOnly = (provider: string): BoardSourceCommentWriteBackError => ({
    error: 'SOURCE_READ_ONLY',
    provider,
    detail: `${providerName(provider)} owns this ticket's comments. Switch the source to read & write in Settings → Sources to change them from here.`,
  })

  const notWritable = (provider: string): BoardSourceCommentWriteBackError => ({
    error: 'COMMENT_NOT_WRITABLE',
    provider,
    detail: `${providerName(provider)} comments cannot be changed from Nessie.`,
  })

  const refusal = (provider: string, cause: unknown): BoardSourceCommentWriteBackError =>
    cause instanceof SourceRejectedError
      ? { error: 'SOURCE_REJECTED', code: cause.code, detail: cause.detail }
      : { error: 'SOURCE_UNAVAILABLE', detail: `${providerName(provider)} could not be reached.` }

  /** The imported comment and its source, or null for a comment born here. */
  const loadImported = async (commentId: string) => {
    const comment = await prisma.taskComment.findUnique({
      where: { id: commentId },
      select: { externalId: true, source: true },
    })
    if (!comment?.externalId || !comment.source) return null
    return { externalId: comment.externalId, source: comment.source }
  }

  return {
    create: async ({ taskId, body }) => {
      const link = await prisma.taskExternalLink.findUnique({
        where: { taskId },
        select: { externalId: true, externalKey: true, source: true },
      })
      if (!link) return { propagated: false, reason: 'not_mirrored' }
      const source = link.source
      if (source.writeMode === 'read_only') return { propagated: false, reason: 'read_only' }
      const prepared = await prepare(source)
      if ('error' in prepared) return prepared
      if (!prepared.adapter.createComment) return { propagated: false, reason: 'unsupported' }
      try {
        const echo = await prepared.adapter.createComment(
          prepared.context,
          source.container as Record<string, unknown>,
          { externalId: link.externalId, externalKey: link.externalKey },
          body,
        )
        return { propagated: true, echo: commentEcho(source.id, echo) }
      } catch (cause) {
        return refusal(source.provider, cause)
      }
    },

    update: async ({ commentId, body }) => {
      const imported = await loadImported(commentId)
      if (!imported) return null
      const { source } = imported
      if (source.writeMode === 'read_only') return readOnly(source.provider)
      const prepared = await prepare(source)
      if ('error' in prepared) return prepared
      if (!prepared.adapter.updateComment) return notWritable(source.provider)
      try {
        const echo = await prepared.adapter.updateComment(
          prepared.context,
          source.container as Record<string, unknown>,
          { externalId: imported.externalId },
          body,
        )
        return { ok: true, echo: commentEcho(source.id, echo) }
      } catch (cause) {
        return refusal(source.provider, cause)
      }
    },

    remove: async ({ commentId }) => {
      const imported = await loadImported(commentId)
      if (!imported) return null
      const { source } = imported
      if (source.writeMode === 'read_only') return readOnly(source.provider)
      const prepared = await prepare(source)
      if ('error' in prepared) return prepared
      if (!prepared.adapter.deleteComment) return notWritable(source.provider)
      try {
        await prepared.adapter.deleteComment(
          prepared.context,
          source.container as Record<string, unknown>,
          { externalId: imported.externalId },
        )
        return { ok: true }
      } catch (cause) {
        return refusal(source.provider, cause)
      }
    },
  }
}

/**
 * The provider collaborator in the shape the shared comment functions take
 * (`TaskCommentWriteBack`): the API routes and the worker's agent tools both
 * build it here, so a comment posted by a person and one posted by an agent
 * reach the provider the same way. A comment that is not propagated (not
 * mirrored, read-only, or an adapter with no comment write) answers `null`
 * and stays Nessie-only.
 */
export const createTaskCommentWriteBackFromSource = (deps: WriteBackDeps) => {
  const source = createBoardSourceCommentWriteBack(deps)
  const asComment = (echo: CommentEcho): NormalisedComment => ({
    externalId: echo.externalId,
    issueExternalId: '',
    body: echo.body,
    author: null,
    createdAt: echo.externalUpdatedAt.toISOString(),
    updatedAt: echo.externalUpdatedAt.toISOString(),
    editedAt: echo.editedAt?.toISOString() ?? null,
    url: echo.externalUrl,
  })
  return {
    createComment: async (input: { taskId: string; body: string }) => {
      const outcome = await source.create(input)
      if ('error' in outcome) return outcome
      return outcome.propagated ? { ok: true as const, comment: asComment(outcome.echo) } : null
    },
    updateComment: async (input: { commentId: string; body: string }) => {
      const outcome = await source.update({ commentId: input.commentId, body: input.body })
      if (!outcome || 'error' in outcome) return outcome
      return { ok: true as const, comment: asComment(outcome.echo) }
    },
    deleteComment: async (input: { commentId: string }) => source.remove({ commentId: input.commentId }),
  }
}

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

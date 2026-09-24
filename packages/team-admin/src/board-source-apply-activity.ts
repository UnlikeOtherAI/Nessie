import { Prisma, type PrismaClient } from '@prisma/client'
import {
  type AssetStream,
  type BoardSourceAdapter,
  type ConnectionContext,
  type NormalisedAttachment,
  type NormalisedComment,
  SourceAssetTooLargeError,
  SourceAuthError,
  SourceHttpError,
  inlineAssetsIn,
} from '@nessie/board-sources'
import type { FileService, LedgerAttribution } from '@nessie/runtime'
import { inlineAttachmentPath } from '@nessie/schemas'

import type { ResolvedIdentity } from './board-source-identity.js'
import { sourceEventAuthorship } from './board-source-apply-events.js'
import { recordTaskEvent } from './task-event-dispatch.js'

/**
 * The parts of an upstream issue that are not the issue: its comments and its
 * files. Separate from `board-source-apply.ts` because none of it is part of the
 * item's fingerprint decision — an `echo` or `unchanged` item still has its
 * comments and files applied, and a comment edited upstream changes no issue.
 *
 * Every write is keyed by `(sourceId, externalId)` or `(sourceId, externalUrl)`,
 * so re-applying a page is a no-op, and nothing here changes a source's
 * health: a file that cannot be fetched is its own row's problem, and the row
 * says so.
 */

export type ActivitySourceContext = {
  id: string
  organizationId: string
  projectId: string
  provider: string
  /** externalUserId → the Nessie identity a person or an auto-match resolved. */
  identityByExternalUserId: Map<string, ResolvedIdentity>
}

/** Tasks whose comments or files changed, so the caller publishes once per job. */
export type ActivityTouched = Set<string>

type Db = PrismaClient | Prisma.TransactionClient

/** How long a stored failure reason may be; it is a code, not a log. */
const LAST_ERROR_MAX_CHARS = 200

/** Attempts before a pending file is given up on and the provider URL kept. */
export const ASSET_FETCH_MAX_ATTEMPTS = 3

/** Files fetched per sync job; the rest wait for the next poll. */
export const ASSET_FETCH_BATCH = 20

const sourceActor = (sourceId: string): string => `source:${sourceId}`

const isUniqueViolation = (cause: unknown): boolean =>
  cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === 'P2002'

// ─── Text ─────────────────────────────────────────────────────────────────────

export type StoredAssetUrl = { externalUrl: string; attachmentId: string | null }

/**
 * Replace every provider URL whose file is stored with the one inline form
 * (`/api/attachments/<id>`). String-exact, so a URL that merely shares a prefix
 * is untouched; a `pending` or `failed` asset has no `attachmentId` and its
 * provider URL stays, which the renderer shows as an ordinary remote image.
 */
export const rewriteProviderUrls = <T extends string | null | undefined>(
  text: T,
  assets: readonly StoredAssetUrl[],
): T => {
  if (!text) return text
  let rewritten: string = text
  for (const asset of assets) {
    if (!asset.attachmentId || !rewritten.includes(asset.externalUrl)) continue
    rewritten = rewritten.split(asset.externalUrl).join(inlineAttachmentPath(asset.attachmentId))
  }
  return rewritten as T
}

/**
 * The reverse, for a description written back upstream: a stored provider file
 * goes back to the provider's own URL; a file born in Nessie becomes an
 * absolute link to this deployment when its origin is known (it then needs a
 * Nessie sign-in to open — the stated gap), and stays relative otherwise.
 */
export const rewriteForProvider = (
  text: string | null,
  assets: readonly StoredAssetUrl[],
  appOrigin?: string | null,
): string | null => {
  if (!text) return text
  let rewritten = text
  for (const asset of assets) {
    if (!asset.attachmentId) continue
    rewritten = rewritten.split(inlineAttachmentPath(asset.attachmentId)).join(asset.externalUrl)
  }
  if (appOrigin) {
    const origin = appOrigin.replace(/\/+$/, '')
    rewritten = rewritten.replace(
      /\]\((\/api\/attachments\/[0-9a-f-]{36})\)/g,
      (_match, path: string) => `](${origin}${path})`,
    )
  }
  return rewritten
}

/** The stored provider files of some tasks, for rewriting their text. */
export const loadStoredAssetUrls = async (
  db: Db,
  sourceId: string,
  taskIds: readonly string[],
): Promise<Map<string, StoredAssetUrl[]>> => {
  const byTask = new Map<string, StoredAssetUrl[]>()
  if (taskIds.length === 0) return byTask
  const rows = await db.taskExternalAsset.findMany({
    where: { sourceId, taskId: { in: [...taskIds] }, status: 'stored', attachmentId: { not: null } },
    select: { taskId: true, externalUrl: true, attachmentId: true },
  })
  for (const row of rows) {
    const list = byTask.get(row.taskId) ?? []
    list.push({ externalUrl: row.externalUrl, attachmentId: row.attachmentId })
    byTask.set(row.taskId, list)
  }
  return byTask
}

/** Which mirrored task each upstream issue id is, within one source. */
const tasksByIssue = async (
  db: Db,
  sourceId: string,
  issueExternalIds: readonly string[],
): Promise<Map<string, string>> => {
  const unique = [...new Set(issueExternalIds.filter(Boolean))]
  if (unique.length === 0) return new Map()
  const links = await db.taskExternalLink.findMany({
    where: { sourceId, externalId: { in: unique } },
    select: { externalId: true, taskId: true },
  })
  return new Map(links.map((link) => [link.externalId, link.taskId]))
}

// ─── Comments ─────────────────────────────────────────────────────────────────

type CommentAuthorColumns = {
  authorUserId: string | null
  authorAgentId: string | null
  externalAuthorExternalId: string | null
  externalAuthorDisplay: string | null
}

/**
 * Who wrote a comment, in columns. A provider user an identity link resolves
 * becomes that person or agent — and then no provider display name is kept,
 * the `remoteAssigneeDisplay` rule. Everyone else, bots included, stays
 * provider data. The external id is always kept: it is what a mapping made
 * later re-attributes by.
 */
export const commentAuthorColumns = (
  comment: Pick<NormalisedComment, 'author' | 'authorDisplay'>,
  identities: Map<string, ResolvedIdentity>,
): CommentAuthorColumns => {
  if (!comment.author) {
    return {
      authorUserId: null,
      authorAgentId: null,
      externalAuthorExternalId: null,
      externalAuthorDisplay: comment.authorDisplay ?? null,
    }
  }
  const linked = identities.get(comment.author.externalUserId)
  // A comment has exactly one author, so a link naming both keeps the person.
  if (linked?.userId || linked?.agentId) {
    return {
      authorUserId: linked.userId ?? null,
      authorAgentId: linked.userId ? null : linked.agentId ?? null,
      externalAuthorExternalId: comment.author.externalUserId,
      externalAuthorDisplay: null,
    }
  }
  return {
    authorUserId: null,
    authorAgentId: null,
    externalAuthorExternalId: comment.author.externalUserId,
    externalAuthorDisplay: comment.author.displayName,
  }
}

/**
 * Upsert upstream comments by `(sourceId, externalId)`.
 *
 * A comment on an issue the mirror does not hold is skipped, not queued: the
 * issue arrives on the next item page and brings its comments with it. A
 * `restricted` comment (a narrower audience than its issue) is never stored.
 * An existing row changes only when the provider's `updatedAt` is newer, and a
 * row deleted here stays deleted.
 */
export const applyInboundComments = async (
  prisma: PrismaClient,
  source: ActivitySourceContext,
  comments: readonly NormalisedComment[],
): Promise<ActivityTouched> => {
  const touched: ActivityTouched = new Set()
  const visible = comments.filter((comment) => !comment.restricted && comment.externalId)
  if (visible.length === 0) return touched

  const taskByIssue = await tasksByIssue(
    prisma,
    source.id,
    visible.map((comment) => comment.issueExternalId),
  )
  const mirrored = visible.filter((comment) => taskByIssue.has(comment.issueExternalId))
  if (mirrored.length === 0) return touched

  const existingRows = await prisma.taskComment.findMany({
    where: { sourceId: source.id, externalId: { in: mirrored.map((comment) => comment.externalId) } },
    select: { id: true, externalId: true, body: true, externalUpdatedAt: true, deletedAt: true },
  })
  const existing = new Map(existingRows.map((row) => [row.externalId as string, row]))
  const stored = await loadStoredAssetUrls(prisma, source.id, [...new Set(taskByIssue.values())])

  for (const comment of mirrored) {
    const taskId = taskByIssue.get(comment.issueExternalId) as string
    const body = rewriteProviderUrls(comment.body, stored.get(taskId) ?? [])
    const author = commentAuthorColumns(comment, source.identityByExternalUserId)
    const updatedAt = new Date(comment.updatedAt)
    const row = existing.get(comment.externalId)

    if (!row) {
      let created: { id: string }
      try {
        created = await prisma.taskComment.create({
          data: {
            organizationId: source.organizationId,
            taskId,
            ...author,
            body,
            sourceId: source.id,
            externalId: comment.externalId,
            externalUrl: comment.url ?? null,
            parentExternalId: comment.parentExternalId ?? null,
            externalUpdatedAt: updatedAt,
            editedAt: comment.editedAt ? new Date(comment.editedAt) : null,
            // The thread reads oldest first, so an imported comment keeps the
            // moment it was written upstream rather than the moment we saw it.
            createdAt: new Date(comment.createdAt),
          },
          select: { id: true },
        })
      } catch (cause) {
        // A sweep page and a webhook applied the same comment at once; the
        // other writer's row is the row.
        if (isUniqueViolation(cause)) continue
        throw cause
      }
      // Its own transaction with its dispatch job: a provider's comment can
      // wake live work when the trigger opts in to source events.
      await prisma.$transaction((tx) => recordTaskEvent(tx, {
        taskId,
        eventType: 'comment_added',
        payload: {
          ...sourceEventAuthorship(source.id),
          commentId: created.id,
          bySourceId: source.id,
          externalId: comment.externalId,
        },
        scope: source,
      }))
      touched.add(taskId)
      continue
    }

    if (row.deletedAt) continue
    if (row.externalUpdatedAt && row.externalUpdatedAt >= updatedAt) continue
    await prisma.taskComment.update({
      where: { id: row.id },
      data: {
        ...author,
        body,
        externalUrl: comment.url ?? null,
        externalUpdatedAt: updatedAt,
        editedAt: comment.editedAt ? new Date(comment.editedAt) : null,
      },
    })
    if (row.body !== body) {
      await prisma.taskEvent.create({
        data: {
          taskId,
          eventType: 'comment_edited',
          payload: { by: sourceActor(source.id), commentId: row.id, bySourceId: source.id },
        },
      })
      touched.add(taskId)
    }
  }
  return touched
}

/**
 * Soft-delete comments the provider says were removed. Only a webhook can say
 * so — polling sees an absence, which is indistinguishable from "not read" —
 * so this is the one door a deletion comes through.
 */
export const removeInboundComments = async (
  prisma: PrismaClient,
  source: Pick<ActivitySourceContext, 'id'>,
  externalIds: readonly string[],
): Promise<ActivityTouched> => {
  const touched: ActivityTouched = new Set()
  if (externalIds.length === 0) return touched
  const rows = await prisma.taskComment.findMany({
    where: { sourceId: source.id, externalId: { in: [...externalIds] }, deletedAt: null },
    select: { id: true, taskId: true },
  })
  for (const row of rows) {
    const result = await prisma.taskComment.updateMany({
      where: { id: row.id, deletedAt: null },
      data: { deletedAt: new Date(), body: '' },
    })
    if (result.count === 0) continue
    await prisma.taskEvent.create({
      data: {
        taskId: row.taskId,
        eventType: 'comment_deleted',
        payload: { by: sourceActor(source.id), commentId: row.id, bySourceId: source.id },
      },
    })
    touched.add(row.taskId)
  }
  return touched
}

/**
 * Inline files inside comment bodies that arrived without an item — the
 * comment lane carries comments only, so their uploads are found here with
 * the adapter's own asset hosts, the same scan the adapter runs on an item.
 */
export const inlineAssetsForComments = (
  comments: readonly NormalisedComment[],
  adapter: { assetHosts?: readonly string[]; isAssetUrl?: (url: string) => boolean },
): NormalisedAttachment[] => {
  const matcher = adapter.isAssetUrl
    ? (url: string) => adapter.isAssetUrl?.(url) ?? false
    : adapter.assetHosts
  return matcher && (typeof matcher === 'function' || matcher.length > 0)
    ? comments
      .filter((comment) => !comment.restricted)
      .flatMap((comment) =>
        inlineAssetsIn(comment.body, matcher, {
          issueExternalId: comment.issueExternalId,
          commentExternalId: comment.externalId,
          createdAt: comment.createdAt,
        }),
      )
    : []
}

// ─── Files ────────────────────────────────────────────────────────────────────

/**
 * Record the files and links an issue carries, by `(sourceId, externalUrl)`. A
 * link is complete as recorded; a file is `pending` until `fetchPendingAssets`
 * stores it. A URL already recorded is left alone — a new URL upstream is a new
 * asset, and a removal upstream is not detected (the stored copy stays).
 */
export const applyInboundAssets = async (
  prisma: PrismaClient,
  source: ActivitySourceContext,
  attachments: readonly NormalisedAttachment[],
): Promise<ActivityTouched> => {
  const touched: ActivityTouched = new Set()
  const candidates = attachments.filter((attachment) => attachment.url)
  if (candidates.length === 0) return touched

  const taskByIssue = await tasksByIssue(
    prisma,
    source.id,
    candidates.map((attachment) => attachment.issueExternalId),
  )
  const commentExternalIds = [
    ...new Set(candidates.flatMap((attachment) => attachment.commentExternalId ?? [])),
  ]
  const comments = commentExternalIds.length > 0
    ? await prisma.taskComment.findMany({
      where: { sourceId: source.id, externalId: { in: commentExternalIds } },
      select: { id: true, externalId: true },
    })
    : []
  const commentByExternalId = new Map(comments.map((row) => [row.externalId as string, row.id]))

  const already = await prisma.taskExternalAsset.findMany({
    where: { sourceId: source.id, externalUrl: { in: candidates.map((attachment) => attachment.url) } },
    select: { externalUrl: true },
  })
  const known = new Set(already.map((row) => row.externalUrl))

  const rows: Prisma.TaskExternalAssetCreateManyInput[] = []
  for (const attachment of candidates) {
    const taskId = taskByIssue.get(attachment.issueExternalId)
    if (!taskId || known.has(attachment.url)) continue
    known.add(attachment.url)
    const link = attachment.kind === 'link'
    rows.push({
      organizationId: source.organizationId,
      taskId,
      taskCommentId: attachment.commentExternalId
        ? commentByExternalId.get(attachment.commentExternalId) ?? null
        : null,
      sourceId: source.id,
      externalUrl: attachment.url,
      externalId: attachment.externalId ?? null,
      kind: link ? 'link' : attachment.inline ? 'inline_image' : 'file',
      status: link ? 'link' : 'pending',
      title: attachment.title ?? null,
    })
    touched.add(taskId)
  }
  if (rows.length > 0) {
    await prisma.taskExternalAsset.createMany({ data: rows, skipDuplicates: true })
  }
  return touched
}

/**
 * The attribution a stored provider file is accounted under: the sync worker
 * is the actor, the connection's owner — whose credential read the file — is
 * who it is done for. The dashboard refresher's shape, for the same reason.
 */
export const boardSourceAssetAttribution = (input: {
  organizationId: string
  projectId: string
  taskId: string
  ownerUserId: string | null
}): LedgerAttribution => ({
  actorId: 'worker.board-source-sync',
  actorType: 'system',
  organizationId: input.organizationId,
  projectId: input.projectId,
  taskId: input.taskId,
  systemComponent: 'worker.board-source-sync',
  userId: input.ownerUserId,
})

export type FetchPendingAssetsInput = {
  source: ActivitySourceContext
  adapter: Pick<BoardSourceAdapter, 'fetchAsset'>
  context: ConnectionContext
  fileService: Pick<FileService, 'store'>
  limit?: number
}

/** Why one fetch failed, as a stable code, and whether retrying could help. */
const classifyAssetFailure = (cause: unknown): { code: string; terminal: boolean } => {
  if (cause instanceof SourceAssetTooLargeError) return { code: 'ASSET_TOO_LARGE', terminal: true }
  if (cause instanceof Error && cause.name === 'FileTooLargeError') {
    return { code: 'ASSET_TOO_LARGE', terminal: true }
  }
  if (cause instanceof SourceAuthError) return { code: 'ASSET_UNAUTHORIZED', terminal: false }
  if (cause instanceof SourceHttpError) return { code: `ASSET_HTTP_${cause.status}`, terminal: false }
  if (cause instanceof Error && cause.name === 'QuotaExceededError') {
    return { code: 'ASSET_STORAGE_QUOTA', terminal: false }
  }
  return { code: 'ASSET_FETCH_FAILED', terminal: false }
}

const filenameFor = (title: string | null, url: string): string => {
  if (title?.trim()) return title.trim().slice(0, 200)
  try {
    const segment = new URL(url).pathname.split('/').filter(Boolean).pop()
    if (segment) return decodeURIComponent(segment).slice(0, 200)
  } catch {
    // fall through to the generic name
  }
  return 'attachment'
}

/**
 * Put the stored file's own path into the text that referenced it: the task's
 * description and any of its comments. Applied once per stored file; the item
 * and comment appliers repeat it on every later write, so a stored image never
 * flips back to the provider URL.
 */
const rewriteTextForStoredAsset = async (
  prisma: PrismaClient,
  taskId: string,
  asset: StoredAssetUrl,
): Promise<void> => {
  const task = await prisma.task.findUnique({ where: { id: taskId }, select: { detail: true } })
  if (task?.detail?.includes(asset.externalUrl)) {
    await prisma.task.update({
      where: { id: taskId },
      data: { detail: rewriteProviderUrls(task.detail, [asset]) },
    })
  }
  const comments = await prisma.taskComment.findMany({
    where: { taskId, deletedAt: null, body: { contains: asset.externalUrl } },
    select: { id: true, body: true },
  })
  for (const comment of comments) {
    await prisma.taskComment.update({
      where: { id: comment.id },
      data: { body: rewriteProviderUrls(comment.body, [asset]) },
    })
  }
}

/**
 * Store up to `limit` pending provider files through the one file chokepoint.
 *
 * Streaming end to end: the adapter's capped stream is the store's body, so a
 * file larger than 25 MiB is refused before anything is kept. A refusal or a
 * timeout counts an attempt and records why; the third makes the row `failed`,
 * and a file gone upstream (`null`) or too large fails at once. A `failed` row
 * keeps its provider URL in the text and is where the Attachments list names
 * the problem.
 */
export const fetchPendingAssets = async (
  prisma: PrismaClient,
  input: FetchPendingAssetsInput,
): Promise<ActivityTouched> => {
  const touched: ActivityTouched = new Set()
  const pending = await prisma.taskExternalAsset.findMany({
    where: { sourceId: input.source.id, status: 'pending' },
    // Least recently tried first, so one stubborn file cannot starve the rest.
    orderBy: { updatedAt: 'asc' },
    take: input.limit ?? ASSET_FETCH_BATCH,
    select: {
      id: true,
      taskId: true,
      taskCommentId: true,
      externalUrl: true,
      title: true,
      attempts: true,
    },
  })

  for (const asset of pending) {
    const fail = async (code: string, terminal: boolean): Promise<void> => {
      const attempts = asset.attempts + 1
      const failed = terminal || attempts >= ASSET_FETCH_MAX_ATTEMPTS
      await prisma.taskExternalAsset.update({
        where: { id: asset.id },
        data: {
          attempts,
          lastError: code.slice(0, LAST_ERROR_MAX_CHARS),
          status: failed ? 'failed' : 'pending',
        },
      })
      if (failed) touched.add(asset.taskId)
    }

    if (!input.adapter.fetchAsset) {
      await fail('ASSET_FETCH_UNSUPPORTED', true)
      continue
    }

    let fetched: AssetStream | null = null
    try {
      fetched = await input.adapter.fetchAsset(input.context, { url: asset.externalUrl })
      if (!fetched) {
        await fail('ASSET_GONE', true)
        continue
      }
      const stored = await input.fileService.store({
        attribution: boardSourceAssetAttribution({
          organizationId: input.source.organizationId,
          projectId: input.source.projectId,
          taskId: asset.taskId,
          ownerUserId: input.context.ownerUserId || null,
        }),
        organizationId: input.source.organizationId,
        // Nobody uploaded it: the sync did, on the connection owner's behalf.
        uploaderId: null,
        filename: filenameFor(asset.title, asset.externalUrl),
        mime: fetched.contentType?.split(';')[0]?.trim() || 'application/octet-stream',
        body: fetched.stream,
        scope: { projectId: input.source.projectId },
      })
      const attachmentId = stored.attachment.id
      // The ticket pointers are app-enforced columns, like `messageId`; the
      // store call does not take them, so they are set on the row it made.
      await prisma.attachment.update({
        where: { id: attachmentId },
        data: { taskId: asset.taskId, taskCommentId: asset.taskCommentId },
      })
      await prisma.taskExternalAsset.update({
        where: { id: asset.id },
        data: { status: 'stored', attachmentId, attempts: asset.attempts + 1, lastError: null },
      })
      await rewriteTextForStoredAsset(prisma, asset.taskId, {
        externalUrl: asset.externalUrl,
        attachmentId,
      })
      touched.add(asset.taskId)
    } catch (cause) {
      fetched?.stream.destroy()
      const failure = classifyAssetFailure(cause)
      await fail(failure.code, failure.terminal)
    }
  }
  return touched
}

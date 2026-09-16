import { Prisma } from '@prisma/client'

import { indexVersionChunks } from '../native-version-writer.js'
import type { NativeKnowledgeProviderOptions } from '../native-version-writer.js'
import type { TransferSpaceScope, TransferSubtreeNode } from './collect.js'

/**
 * A cross-space copy, to the row and the byte.
 *
 * A copy is a **new document with a known origin**, not a second pointer at the
 * source. It carries the current version only, gets new ids, carries its basis
 * rows (provenance travels with content) and deliberately carries no shares, no
 * annotations, no backlinks, no task binding and no agent core-document role —
 * the decided table is transfer.md §3.5.
 *
 * It writes **no chunks of its own from the source's**: the copy re-enters the
 * pipeline exactly as a new page would, and the embed job's copy-by-content-hash
 * step then reuses the source's vectors, so an indexed page is searchable again
 * within seconds without a provider call. Copying chunk rows would carry the
 * source's scope until something rewrote it, which is the failure this whole
 * design exists to prevent.
 *
 * Bytes are re-stored, never referenced — see `FileService.copy`. Because
 * object I/O cannot join a database transaction, the copy is two phases:
 * `planTransferCopy` writes every row inside the caller's transaction and
 * returns the attachment work, and `applyTransferCopyAttachments` runs that work
 * afterwards with a compensating rollback. There is no third option: a
 * `FileService.copy` inside the outer transaction would open a second
 * connection while this one holds both tree locks.
 */

// `metadata` travels with a copy except for the three keys that describe the
// source's place in the world rather than its content.
const DROPPED_METADATA_KEYS = new Set(['transfer', 'taskId', 'folder'])

export type TransferCopyAttachmentWork = {
  sourceAttachmentId: string
  newPageId: string
  /** Set for a file node's version attachment; null for a drawer attachment. */
  newVersionId: string | null
}

export type TransferCopyPlan = {
  /** Source page id → the copy's id, in parent-before-child order. */
  idMap: Array<{ sourcePageId: string; pageId: string }>
  attachmentWork: TransferCopyAttachmentWork[]
}

export type PlanTransferCopyInput = {
  organizationId: string
  targetSpace: TransferSpaceScope
  nodes: readonly TransferSubtreeNode[]
  parentPageId: string | null
  startPosition: number
  actor: { actorId: string; actorType: 'user' | 'agent' }
  /** Names the source in the copied version's change comment. */
  sourceSpaceName: string
  /** Wired by the caller so a copied published document enqueues its embed job
   * inside this same transaction, exactly as an ordinary save does. */
  providerOptions?: NativeKnowledgeProviderOptions
}

type SourceVersionRow = {
  id: string
  body: string | null
  bodyRef: string | null
  attachmentId: string | null
  sourceContentHash: string | null
  trust: string
  origin: string
}

const copiedMetadata = (metadata: Prisma.JsonValue | null): Prisma.InputJsonValue | null => {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const kept = Object.fromEntries(
    Object.entries(metadata as Record<string, unknown>)
      .filter(([key]) => !DROPPED_METADATA_KEYS.has(key)),
  )
  return Object.keys(kept).length === 0 ? null : (kept as Prisma.InputJsonValue)
}

/** `publishedVersion ?? latestVersion` — the one version a copy carries. */
const currentVersion = async (
  tx: Prisma.TransactionClient,
  node: TransferSubtreeNode,
): Promise<SourceVersionRow | null> => {
  if (node.publishedVersionId) {
    const published = await tx.knowledgePageVersion.findUnique({
      where: { id: node.publishedVersionId },
      select: {
        id: true, body: true, bodyRef: true, attachmentId: true,
        sourceContentHash: true, trust: true, origin: true,
      },
    })
    if (published) return published as SourceVersionRow
  }
  const latest = await tx.knowledgePageVersion.findFirst({
    where: { pageId: node.id },
    orderBy: { versionNumber: 'desc' },
    select: {
      id: true, body: true, bodyRef: true, attachmentId: true,
      sourceContentHash: true, trust: true, origin: true,
    },
  })
  return (latest as SourceVersionRow | null) ?? null
}

export const planTransferCopy = async (
  tx: Prisma.TransactionClient,
  input: PlanTransferCopyInput,
): Promise<TransferCopyPlan> => {
  const space = input.targetSpace
  const idMap: TransferCopyPlan['idMap'] = []
  const newIdBySourceId = new Map<string, string>()
  const attachmentWork: TransferCopyAttachmentWork[] = []
  let rootPosition = input.startPosition

  // `nodes` is already parent-before-child (`ORDER BY depth`), which is what
  // makes the id map complete by the time a child needs its parent's new id.
  for (const node of input.nodes) {
    const source = await tx.knowledgePage.findUnique({
      where: { id: node.id },
      select: {
        title: true, summary: true, metadata: true, kind: true, status: true,
        position: true, labels: { select: { name: true, normalizedName: true } },
      },
    })
    if (!source) continue

    const parentPageId = node.isRoot
      ? input.parentPageId
      : (node.parentPageId ? newIdBySourceId.get(node.parentPageId) ?? null : null)
    const position = node.isRoot ? rootPosition : source.position
    if (node.isRoot) rootPosition += 1

    const created = await tx.knowledgePage.create({
      data: {
        spaceId: space.id,
        organizationId: input.organizationId,
        projectId: space.projectId,
        teamId: space.teamId,
        channelId: space.channelId,
        threadId: space.threadId,
        userId: space.userId,
        visibility: space.visibility as never,
        sensitivityTier: space.sensitivityTier as never,
        privateToAgentId: space.privateToAgentId,
        title: source.title,
        summary: source.summary,
        metadata: copiedMetadata(source.metadata) ?? Prisma.DbNull,
        kind: source.kind,
        status: source.status,
        parentPageId,
        position,
        // Never the source's role: a copy of an agent's ordinary page is an
        // ordinary page, and its active instructions are refused outright.
        documentRole: 'knowledge',
        // A ticket's documents live in its project; the copy is a plain page.
        taskId: null,
        createdBy: input.actor.actorId,
      },
      select: { id: true },
    })
    newIdBySourceId.set(node.id, created.id)
    idMap.push({ sourcePageId: node.id, pageId: created.id })

    if (source.labels.length > 0) {
      await tx.pageLabel.createMany({
        data: source.labels.map((label) => ({
          organizationId: input.organizationId,
          pageId: created.id,
          name: label.name,
          normalizedName: label.normalizedName,
        })),
      })
    }

    const version = await currentVersion(tx, node)
    if (!version) continue

    const copiedVersion = await tx.knowledgePageVersion.create({
      data: {
        pageId: created.id,
        versionNumber: 1,
        body: version.body,
        bodyRef: version.bodyRef,
        // Pointed at the source's bytes only until phase two re-stores them;
        // `applyTransferCopyAttachments` overwrites this with the new row's id
        // and the rollback removes the page entirely if it cannot.
        attachmentId: null,
        sourceContentHash: version.sourceContentHash,
        authorType: input.actor.actorType,
        authorId: input.actor.actorId,
        changeComment: `Copied from ${input.sourceSpaceName}`,
        trust: version.trust as never,
        origin: 'user_authored',
      },
      select: { id: true },
    })

    // Provenance travels with content: §4.1 has already judged the destination
    // able to satisfy these, but the rows must exist so a later move of the
    // copy is judged on the truth rather than on an empty basis.
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO knowledge_page_version_basis_scopes
        (version_id, organization_id, scope_type, scope_id)
      SELECT ${copiedVersion.id}::uuid, organization_id, scope_type, scope_id
      FROM knowledge_page_version_basis_scopes
      WHERE version_id = ${version.id}::uuid
      ON CONFLICT DO NOTHING
    `)
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO knowledge_page_version_disclosure_sources
        (version_id, organization_id, source_channel_id, source_author_user_id)
      SELECT ${copiedVersion.id}::uuid, organization_id, source_channel_id, source_author_user_id
      FROM knowledge_page_version_disclosure_sources
      WHERE version_id = ${version.id}::uuid
      ON CONFLICT DO NOTHING
    `)

    if (source.status === 'published') {
      await tx.knowledgePage.update({
        where: { id: created.id },
        data: { publishedVersionId: copiedVersion.id },
      })
      // Chunks + links + the embed enqueue, exactly as an ordinary publish
      // does. A folder returns early inside; a file node has no body and
      // chunks nothing until the extract job runs.
      await indexVersionChunks(
        tx,
        input.providerOptions ?? {},
        {
          id: created.id,
          organizationId: input.organizationId,
          projectId: space.projectId,
          teamId: space.teamId,
          channelId: space.channelId,
          threadId: space.threadId,
          userId: space.userId,
          visibility: space.visibility,
          sensitivityTier: space.sensitivityTier,
          privateToAgentId: space.privateToAgentId,
          taskId: null,
          kind: source.kind,
        },
        { id: copiedVersion.id, body: version.body },
      )
    }

    if (version.attachmentId) {
      attachmentWork.push({
        sourceAttachmentId: version.attachmentId,
        newPageId: created.id,
        newVersionId: copiedVersion.id,
      })
    }
    const drawer = await tx.attachment.findMany({
      where: { knowledgePageId: node.id, organizationId: input.organizationId },
      select: { id: true },
    })
    for (const attachment of drawer) {
      if (attachment.id === version.attachmentId) continue
      attachmentWork.push({
        sourceAttachmentId: attachment.id,
        newPageId: created.id,
        newVersionId: null,
      })
    }
  }

  return { idMap, attachmentWork }
}

/**
 * Undo the rows a plan wrote.
 *
 * The rows have to be committed before the bytes are stored — `FileService`
 * runs its quota admission in its own transaction on its own connection, and a
 * page row still invisible outside this one would make that a race at best —
 * so "a half-copy leaves nothing" is compensation, not a rollback. Deleting the
 * pages cascades their versions, chunks, labels and basis rows; the attachments
 * are freed by `applyTransferCopyAttachments`' own failure path.
 */
export const rollbackTransferCopy = async (
  tx: Pick<Prisma.TransactionClient, 'knowledgePage'>,
  input: { organizationId: string; pageIds: readonly string[] },
): Promise<number> => {
  if (input.pageIds.length === 0) return 0
  // Children first is not needed — `parent_page_id` is ON DELETE SET NULL and
  // every id in the map is deleted in the same statement.
  const deleted = await tx.knowledgePage.deleteMany({
    where: { id: { in: [...input.pageIds] }, organizationId: input.organizationId },
  })
  return deleted.count
}

/**
 * The bytes half of a copy, and its rollback.
 *
 * Structurally typed rather than importing `FileService` so `@nessie/knowledge`
 * keeps no dependency on `@nessie/runtime`; the real service satisfies it.
 */
export type TransferCopyFileOps = {
  copy(
    attachmentId: string,
    input: {
      organizationId: string
      uploaderId: string | null
      scope: { projectId?: string | null; teamId?: string | null; spaceId?: string | null }
      knowledgePageId?: string | null
      attribution: unknown
    },
  ): Promise<{ attachment: { id: string } } | null>
  delete(
    attachmentId: string,
    organizationId: string,
    attribution: never,
    scope?: { projectId?: string | null; teamId?: string | null; spaceId?: string | null },
  ): Promise<boolean>
}

export type ApplyTransferCopyAttachmentsInput = {
  organizationId: string
  targetSpace: TransferSpaceScope
  work: readonly TransferCopyAttachmentWork[]
  actorUserId: string | null
  attribution: unknown
}

/**
 * Re-stores every attachment the plan named. On any failure it deletes the
 * copies it had already stored and rethrows, so the caller's own rollback of
 * the rows leaves **nothing** behind — not a page, not an `Attachment` row, not
 * an orphan object in the bucket. A quota refusal arrives here as the
 * `QuotaExceededError` the store threw and is answered 507 upstream.
 */
export const applyTransferCopyAttachments = async (
  files: TransferCopyFileOps,
  prisma: Pick<Prisma.TransactionClient, 'knowledgePageVersion'>,
  input: ApplyTransferCopyAttachmentsInput,
): Promise<{ attachmentsCopied: number }> => {
  const scope = {
    projectId: input.targetSpace.projectId,
    teamId: input.targetSpace.teamId,
    spaceId: input.targetSpace.id,
  }
  const stored: string[] = []
  try {
    for (const item of input.work) {
      const copied = await files.copy(item.sourceAttachmentId, {
        organizationId: input.organizationId,
        uploaderId: input.actorUserId,
        scope,
        knowledgePageId: item.newPageId,
        attribution: input.attribution,
      })
      // A source attachment that vanished between the plan and here leaves the
      // copy without bytes rather than failing the whole transfer: the row it
      // would have backed is a file node whose version simply has no
      // attachment, which every reader already handles.
      if (!copied) continue
      stored.push(copied.attachment.id)
      if (item.newVersionId) {
        await prisma.knowledgePageVersion.update({
          where: { id: item.newVersionId },
          data: { attachmentId: copied.attachment.id },
        })
      }
    }
    return { attachmentsCopied: stored.length }
  } catch (error) {
    for (const attachmentId of stored) {
      await files
        .delete(attachmentId, input.organizationId, input.attribution as never, scope)
        .catch(() => undefined)
    }
    throw error
  }
}

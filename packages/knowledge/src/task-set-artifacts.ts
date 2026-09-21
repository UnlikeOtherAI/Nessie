import { createReadStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrismaClient } from '@prisma/client'
import type { FileService, LedgerAttribution } from '@nessie/runtime'
import { TaskSetDisclosureSchema, type TaskSetDisclosure } from '@nessie/schemas'
import type { KnowledgeProvider } from './types.js'
import type { TaskSetArtifactDestination } from './task-set-access.js'
import { renderTaskSetArtifact, type TaskSetArtifactFormat, type TaskSetArtifactRow } from './task-set-output-render.js'
import { TaskSetSourceError, taskSetHash } from './task-set-records.js'

export type TaskSetArtifactReceipt = {
  attachmentId: string
  contentHash: string
  disclosure: TaskSetDisclosure
  filename: string
  mime: string
}

export type TaskSetArtifactDeps = {
  prisma: PrismaClient
  fileService: Pick<FileService, 'store' | 'openStream' | 'delete'>
  provider: Pick<KnowledgeProvider, 'createPage'>
  /** The core supplies fresh identity proof through resolveTaskSetArtifactDestination. */
  authorizeDestination: () => Promise<TaskSetArtifactDestination>
  /** Persist before page creation; replay supplies this receipt instead of rendering again. */
  recordReceipt: (receipt: TaskSetArtifactReceipt) => Promise<void>
}

export const taskSetArtifactPageId = (organizationId: string, operationKey: string): string => {
  const hash = taskSetHash(`task-set-artifact:${organizationId}:${operationKey}`)
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

export const finalizeTaskSetArtifact = async (
  deps: TaskSetArtifactDeps,
  input: {
    organizationId: string
    operationKey: string
    title: string
    output: TaskSetArtifactFormat
    actor: { id: string; type: 'user' | 'agent' }
    attribution: LedgerAttribution
    rows: AsyncIterable<TaskSetArtifactRow>
    receipt?: TaskSetArtifactReceipt
  },
): Promise<{ pageId: string; attachmentId: string }> => {
  const destination = await deps.authorizeDestination()
  const pageId = taskSetArtifactPageId(input.organizationId, input.operationKey)
  const existing = await deps.prisma.knowledgePage.findFirst({
    where: { id: pageId, organizationId: input.organizationId },
    select: { deletedAt: true, metadata: true, spaceId: true, parentPageId: true,
      versions: { orderBy: { versionNumber: 'desc' }, take: 1, select: { attachmentId: true } } },
  })
  if (existing) {
    const metadata = existing.metadata as {
      taskSetArtifact?: string; attachmentId?: string; contentHash?: string
    } | null
    const attachmentId = existing.versions[0]?.attachmentId
    if (existing.deletedAt || existing.spaceId !== destination.spaceId
      || existing.parentPageId !== destination.parentPageId || metadata?.taskSetArtifact !== input.operationKey
      || !attachmentId || metadata.attachmentId !== attachmentId
      || (input.receipt && metadata.contentHash !== input.receipt.contentHash)) {
      throw new TaskSetSourceError('output_conflict', 'The previously saved output has been moved, edited or deleted.')
    }
    return { pageId, attachmentId }
  }

  let receipt = input.receipt
  if (!receipt) {
    const directory = await mkdtemp(join(tmpdir(), 'nessie-task-output-'))
    try {
      const path = join(directory, 'result')
      const rendered = await renderTaskSetArtifact(path, input.output, input.rows, deps.authorizeDestination)
      await deps.authorizeDestination()
      const name = input.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 160) || 'Results'
      const filename = `${name}.${rendered.extension}`
      const stored = await deps.fileService.store({
        organizationId: input.organizationId, attribution: input.attribution,
        uploaderId: input.actor.type === 'user' ? input.actor.id : null,
        body: createReadStream(path), filename, mime: rendered.mime,
        scope: destination,
      })
      receipt = { attachmentId: stored.attachment.id, filename, mime: rendered.mime,
        contentHash: rendered.contentHash, disclosure: rendered.disclosure }
      await deps.recordReceipt(receipt)
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
  const disclosure = TaskSetDisclosureSchema.parse(receipt.disclosure)
  const bytes = await deps.fileService.openStream(receipt.attachmentId, input.organizationId)
  if (!bytes) throw new TaskSetSourceError('output_unavailable', 'The saved output bytes are unavailable.')
  bytes.stream.destroy()
  const current = await deps.authorizeDestination()
  if (current.spaceId !== destination.spaceId || current.parentPageId !== destination.parentPageId) {
    throw new TaskSetSourceError('output_conflict', 'The output destination changed during finalization.')
  }
  try {
    const page = await deps.provider.createPage({
      ...destination, id: pageId, organizationId: input.organizationId, title: receipt.filename,
      kind: 'file', attachmentId: receipt.attachmentId, authorId: input.actor.id, authorType: input.actor.type,
      createdBy: input.actor.id, origin: 'agent_authored', trust: 'inferred', ...disclosure,
      metadata: {
        taskSetArtifact: input.operationKey, contentHash: receipt.contentHash, attachmentId: receipt.attachmentId,
      },
    })
    return { pageId: page.id, attachmentId: receipt.attachmentId }
  } catch (error) {
    // The deterministic page key fences concurrent finalizers; the next invocation verifies its receipt.
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
      return finalizeTaskSetArtifact(deps, { ...input, receipt })
    }
    throw error
  }
}

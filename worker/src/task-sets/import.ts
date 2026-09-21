import type { PrismaClient } from '@prisma/client'
import { iterateTaskSetSource } from '@nessie/knowledge'
import type { FileService } from '@nessie/runtime'
import { AuthorizedActionContextSchema, TaskSetSourceSchema, type TaskSetImportedItem } from '@nessie/schemas'
import { authorizeTaskSetSource, enqueueTaskSet, lockTaskSet, taskSetJson } from '@nessie/team-admin'

export const importTaskSetSource = async (
  prisma: PrismaClient, fileService: FileService, id: string, signal?: AbortSignal,
): Promise<void> => {
  const set = await prisma.taskSet.findUniqueOrThrow({ where: { id } })
  if (set.status !== 'importing' || set.inputClosedAt) return
  const actor = AuthorizedActionContextSchema.parse(set.launchOrigin)
  const source = TaskSetSourceSchema.parse(set.source)
  let batch: TaskSetImportedItem[] = []
  const flush = async (): Promise<boolean> => prisma.$transaction(async (tx) => {
    await lockTaskSet(tx, id)
    const live = await tx.taskSet.findUniqueOrThrow({ where: { id } })
    if (live.status !== 'importing') return false
    const fresh = batch.filter((record) => record.ordinal > live.importOrdinal)
    if (fresh.length === 0) return true
    await tx.taskSetItem.createMany({ data: fresh.map((record, index) => ({
      taskSetId: id, sequence: live.totalItems + index + 1, clientKey: record.key,
      prompt: '', input: taskSetJson(record.input), sourceLocator: record.sourceLocator, inputHash: record.inputHash,
      disclosure: taskSetJson(record.disclosure),
    })) })
    await tx.taskSet.update({ where: { id }, data: {
      totalItems: { increment: fresh.length }, importOrdinal: fresh.at(-1)!.ordinal,
      nextAttemptAt: new Date(Date.now() + 60_000),
    } })
    return true
  })
  for await (const record of iterateTaskSetSource({
    fileService, organizationId: set.organizationId,
    authorize: async () => {
      const resolved = await authorizeTaskSetSource(prisma, actor, source, { processingAgentId: set.executionAgentId })
      if (resolved.attachmentId !== set.sourceAttachmentId) throw new Error('source_revision_changed')
      return resolved
    },
  }, { source, afterOrdinal: set.importOrdinal })) {
    if (signal?.aborted) return
    batch.push(record)
    if (batch.length === 200) {
      if (!(await flush())) return
      batch = []
    }
  }
  if (batch.length && !(await flush())) return
  await prisma.$transaction(async (tx) => {
    await lockTaskSet(tx, id)
    const live = await tx.taskSet.findUniqueOrThrow({ where: { id } })
    if (live.status !== 'importing') return
    const updated = await tx.taskSet.update({ where: { id }, data: {
      status: 'running', inputClosedAt: new Date(), statusChangedAt: new Date(), revision: { increment: 1 },
    } })
    await enqueueTaskSet(tx, id, updated.revision)
  })
}

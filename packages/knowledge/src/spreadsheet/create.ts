import { Prisma } from '@prisma/client'

import { createEmptyWorkbook, engineVersion, type SpreadsheetWorkbook } from './engine.js'
import type { SpreadsheetServiceDeps } from './deps.js'
import type { KnowledgePageRecord } from '../types.js'

/**
 * Creating a spreadsheet page: the `KnowledgePage` row through the provider's
 * ordinary `createPage` (so labels, links, disclosure and the space's scope
 * are inherited exactly as any page's are), plus the head row that makes it a
 * workbook.
 */

export type CreateSpreadsheetPageInput = {
  organizationId: string
  spaceId: string
  projectId: string
  title: string
  parentPageId?: string | null
  taskId?: string | null
  authorId: string
  authorType: 'user' | 'agent'
  createdBy: string
}

/**
 * Write the head for a page that already exists. Separated from page creation
 * so import, convert and engine-migrate reuse exactly one definition of what a
 * head is at seq 0.
 */
export const writeSpreadsheetHead = async (
  tx: Prisma.TransactionClient,
  input: { pageId: string; organizationId: string; workbook: SpreadsheetWorkbook },
): Promise<void> => {
  await tx.spreadsheetHead.create({
    data: {
      pageId: input.pageId,
      organizationId: input.organizationId,
      headSeq: BigInt(0),
      engineVersion: engineVersion(),
      hotSnapshot: Buffer.from(input.workbook.model.toBytes()),
      hotSnapshotSeq: BigInt(0),
      sheetNames: input.workbook.model.sheets().map((sheet) => sheet.name),
      filters: {},
    },
  })
}

export const createSpreadsheetPage = async (
  deps: SpreadsheetServiceDeps,
  input: CreateSpreadsheetPageInput,
): Promise<KnowledgePageRecord> => {
  const page = await deps.createPage({
    organizationId: input.organizationId,
    projectId: input.projectId,
    spaceId: input.spaceId,
    title: input.title,
    kind: 'spreadsheet',
    authorId: input.authorId,
    authorType: input.authorType,
    createdBy: input.createdBy,
    origin: input.authorType === 'agent' ? 'agent_authored' : 'user_authored',
    trust: 'explicitly_confirmed',
    parentPageId: input.parentPageId ?? null,
    taskId: input.taskId ?? null,
  })

  // One sheet, no first version: the first durable version is deferred to the
  // first compaction, so creating a page does not cost an xlsx write.
  const workbook = createEmptyWorkbook('Sheet1')
  try {
    await deps.prisma.$transaction((tx) =>
      writeSpreadsheetHead(tx, {
        pageId: page.id,
        organizationId: input.organizationId,
        workbook,
      }),
    )
  } catch (error) {
    // A page with no head is not a spreadsheet, just an unopenable row.
    await deps.prisma.knowledgePage
      .update({ where: { id: page.id }, data: { deletedAt: new Date() } })
      .catch(() => undefined)
    throw error
  }
  deps.cache.set(page.id, { workbook, seq: 0, engineVersion: engineVersion(), bytes: 0 })
  return page
}

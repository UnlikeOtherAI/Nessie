import type { PrismaClient } from '@prisma/client'

import { readCanonicalMarkdownAttachment, type MarkdownAttachmentReader } from './markdown-projection.js'

export const CORE_DOCUMENT_ROLES = ['identity', 'working_rules'] as const
export type CoreDocumentRole = (typeof CORE_DOCUMENT_ROLES)[number]

export type ActiveCoreDocument = {
  pageId: string
  role: CoreDocumentRole
  title: string
  versionId: string
  versionNumber: number
  markdown: string
}

export class CoreDocumentIntegrityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CoreDocumentIntegrityError'
  }
}

const coreTitle = (role: CoreDocumentRole): string =>
  role === 'identity' ? 'Identity.md' : 'Working style.md'

/**
 * Loads only the exact published version bound to a typed core mapping. It
 * intentionally does not inspect a page's latest draft, title, or metadata.
 */
export const loadActiveAgentCoreDocuments = async (
  prisma: PrismaClient,
  input: { agentId: string; organizationId: string; readMarkdownAttachment: MarkdownAttachmentReader },
): Promise<ActiveCoreDocument[]> => {
  const [marker, rows] = await Promise.all([
    prisma.agentCoreDocumentMigration.findUnique({
      where: { agentId: input.agentId },
      select: { documentCount: true },
    }),
    prisma.agentCoreDocument.findMany({
      where: {
        agentId: input.agentId,
        agent: { organizationId: input.organizationId },
      },
      orderBy: { role: 'asc' },
      select: {
        page: {
          select: {
            deletedAt: true,
            id: true,
            publishedVersion: {
              select: { attachmentId: true, id: true, sourceContentHash: true, versionNumber: true },
            },
          },
        },
        role: true,
      },
    }),
  ])
  if (rows.length === 0) {
    if (!marker || marker.documentCount === 0) return []
    throw new CoreDocumentIntegrityError('Agent core instructions were removed; publish both required documents')
  }
  if (rows.length !== CORE_DOCUMENT_ROLES.length
    || (marker !== null && marker.documentCount !== rows.length)
    || new Set(rows.map((row) => row.role)).size !== CORE_DOCUMENT_ROLES.length) {
    throw new CoreDocumentIntegrityError('Agent core instructions are incomplete; publish both Identity and Working style documents')
  }
  return Promise.all(rows.map(async (row) => {
    const version = row.page.publishedVersion
    if (row.page.deletedAt) {
      throw new CoreDocumentIntegrityError(`Published ${row.role} instructions were removed`)
    }
    if (!version?.attachmentId || !version.sourceContentHash) {
      throw new CoreDocumentIntegrityError(`Published ${row.role} instructions have no canonical Markdown source`)
    }
    const source = await readCanonicalMarkdownAttachment(
      input.readMarkdownAttachment,
      version.attachmentId,
      input.organizationId,
    )
    if (source.sourceContentHash !== version.sourceContentHash) {
      throw new CoreDocumentIntegrityError(`Published ${row.role} instructions no longer match their approved version`)
    }
    return {
      pageId: row.page.id,
      role: row.role,
      title: coreTitle(row.role),
      versionId: version.id,
      versionNumber: version.versionNumber,
      markdown: source.content,
    }
  }))
}

export const isAgentCoreDocumentPage = async (
  prisma: PrismaClient,
  pageId: string,
): Promise<{ agentId: string; role: CoreDocumentRole } | null> =>
  prisma.agentCoreDocument.findUnique({
    where: { pageId },
    select: { agentId: true, role: true },
  })

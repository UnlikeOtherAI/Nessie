import type { PrismaClient } from '@prisma/client'

import { readCanonicalMarkdownAttachment, type MarkdownAttachmentReader } from './markdown-projection.js'
import {
  CORE_DOCUMENT_ROLES,
  coreDocumentFilename,
  type CoreDocumentRole,
} from './agent-core-contract.js'

export { CORE_DOCUMENT_ROLES, coreDocumentFilename }
export type { CoreDocumentRole }

export type ActiveCoreDocument = {
  basisScopes: Array<{ scopeId: string; scopeType: string }>
  disclosureSources: Array<{ sourceAuthorUserId: string | null; sourceChannelId: string }>
  pageId: string
  role: CoreDocumentRole
  spaceId: string
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

/**
 * Loads only the exact published version bound to a typed core mapping. It
 * intentionally does not inspect a page's latest draft, title, or metadata.
 */
export const loadActiveAgentCoreDocuments = async (
  prisma: PrismaClient,
  input: {
    agentId: string
    authorize?: (document: Omit<ActiveCoreDocument, 'markdown'>) => Promise<void>
    organizationId: string
    readMarkdownAttachment: MarkdownAttachmentReader
  },
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
            parentPageId: true,
            projectId: true,
            sensitivityTier: true,
            title: true,
            visibility: true,
            documentRole: true,
            kind: true,
            space: {
              select: {
                deletedAt: true,
                id: true,
                organizationId: true,
                ownerAgentId: true,
                projectId: true,
                sensitivityTier: true,
                visibility: true,
              },
            },
            publishedVersion: {
              select: {
                attachmentId: true,
                basisScopes: { select: { scopeId: true, scopeType: true } },
                disclosureSources: {
                  select: { sourceAuthorUserId: true, sourceChannelId: true },
                },
                id: true,
                sourceContentHash: true,
                versionNumber: true,
              },
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
    throw new CoreDocumentIntegrityError('Agent core instructions are incomplete; publish both AGENTS.md and personality.md')
  }
  // Validate the complete pair before authorizing or opening either file. A
  // malformed sibling must not turn Promise.all into a partial read of the
  // other instruction while the first rejection is already in flight.
  const validated = rows.map((row) => {
    const version = row.page.publishedVersion
    if (row.page.deletedAt || row.page.space.deletedAt) {
      throw new CoreDocumentIntegrityError(`Published ${row.role} instructions were removed`)
    }
    if (
      row.page.kind !== 'file'
      || row.page.documentRole !== row.role
      || row.page.parentPageId !== null
      || row.page.title !== coreDocumentFilename(row.role)
      || row.page.space.organizationId !== input.organizationId
      || row.page.space.ownerAgentId !== input.agentId
      || row.page.projectId !== row.page.space.projectId
      || row.page.sensitivityTier !== row.page.space.sensitivityTier
      || row.page.visibility !== row.page.space.visibility
    ) {
      throw new CoreDocumentIntegrityError(`Published ${row.role} instructions are outside the agent's canonical home`)
    }
    if (!version?.attachmentId || !version.sourceContentHash) {
      throw new CoreDocumentIntegrityError(`Published ${row.role} instructions have no canonical Markdown source`)
    }
    const document = {
      basisScopes: version.basisScopes,
      disclosureSources: version.disclosureSources,
      pageId: row.page.id,
      role: row.role,
      spaceId: row.page.space.id,
      title: coreDocumentFilename(row.role),
      versionId: version.id,
      versionNumber: version.versionNumber,
    }
    return { document, sourceContentHash: version.sourceContentHash, attachmentId: version.attachmentId }
  })
  return Promise.all(validated.map(async ({ attachmentId, document, sourceContentHash }) => {
    // A run must prove the live home and source-version entitlement before
    // opening a single instruction byte. Human read paths can omit this only
    // after they have already made the same decision at their route boundary.
    if (input.authorize) await input.authorize(document)
    const source = await readCanonicalMarkdownAttachment(
      input.readMarkdownAttachment,
      attachmentId,
      input.organizationId,
    )
    if (source.sourceContentHash !== sourceContentHash) {
      throw new CoreDocumentIntegrityError(`Published ${document.role} instructions no longer match their approved version`)
    }
    return {
      ...document,
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

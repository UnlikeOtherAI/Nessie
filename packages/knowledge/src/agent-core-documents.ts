import type { PrismaClient } from '@prisma/client'

import { readCanonicalMarkdownAttachment, type MarkdownAttachmentReader } from './markdown-projection.js'
import type { KnowledgeProvider, KnowledgePageRecord } from './types.js'

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
  const rows = await prisma.agentCoreDocument.findMany({
    where: {
      agentId: input.agentId,
      agent: { organizationId: input.organizationId },
      // A page with a newer draft remains active at its earlier publication.
      // `status='draft'` must never suppress that explicitly approved pointer.
      page: { deletedAt: null, publishedVersionId: { not: null } },
    },
    orderBy: { role: 'asc' },
    select: {
      page: {
        select: {
          id: true,
          title: true,
          publishedVersion: {
            select: { attachmentId: true, id: true, sourceContentHash: true, versionNumber: true },
          },
        },
      },
      role: true,
    },
  })
  return Promise.all(rows.map(async (row) => {
    const version = row.page.publishedVersion
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
      title: row.page.title,
      versionId: version.id,
      versionNumber: version.versionNumber,
      markdown: source.content,
    }
  }))
}

export type CreateAgentCoreDocumentInput = {
  agentId: string
  attachmentId: string
  authorId: string
  organizationId: string
  projectId: string
  role: CoreDocumentRole
  spaceId: string
  legacySourceHash?: string | null
  origin?: 'legacy_migration' | 'user_authored'
}

/**
 * Creates one Markdown-backed, immediately published core document. The
 * attachment must already have passed through FileService; the provider reads
 * those bytes to derive the one permissible HTML projection.
 */
export const createAgentCoreDocument = async (
  prisma: PrismaClient,
  provider: KnowledgeProvider,
  input: CreateAgentCoreDocumentInput,
): Promise<KnowledgePageRecord> => {
  const existing = await prisma.agentCoreDocument.findUnique({
    where: { agentId_role: { agentId: input.agentId, role: input.role } },
    select: { pageId: true },
  })
  if (existing) {
    throw new Error(`Core ${input.role} document already exists`)
  }
  const page = await provider.createPage({
    attachmentId: input.attachmentId,
    authorId: input.authorId,
    authorType: 'user',
    createdBy: input.authorId,
    documentRole: input.role,
    kind: 'file',
    organizationId: input.organizationId,
    origin: input.origin ?? 'user_authored',
    projectId: input.projectId,
    spaceId: input.spaceId,
    title: coreTitle(input.role),
    trust: input.origin === 'legacy_migration' ? 'unverified_import' : 'explicitly_confirmed',
  })
  try {
    const published = await provider.publishPage({
      actorUserId: input.authorId,
      organizationId: input.organizationId,
      pageId: page.id,
    })
    if (!published) throw new Error('Core document could not be published')
    await prisma.agentCoreDocument.create({
      data: {
        agentId: input.agentId,
        legacySourceHash: input.legacySourceHash ?? null,
        migratedAt: input.origin === 'legacy_migration' ? new Date() : null,
        pageId: page.id,
        role: input.role,
      },
    })
    return published
  } catch (error) {
    // The mapping is what makes this a core document. Leave a failed creation
    // unreachable rather than allowing a title to accidentally become active.
    await prisma.knowledgePage.update({ where: { id: page.id }, data: { status: 'archived' } })
    throw error
  }
}

export const isAgentCoreDocumentPage = async (
  prisma: PrismaClient,
  pageId: string,
): Promise<{ agentId: string; role: CoreDocumentRole } | null> =>
  prisma.agentCoreDocument.findUnique({
    where: { pageId },
    select: { agentId: true, role: true },
  })

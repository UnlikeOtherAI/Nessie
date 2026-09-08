import type { PrismaClient } from '@prisma/client'
import type { FileService } from '@nessie/runtime'
import { readCanonicalMarkdownAttachment } from '@nessie/knowledge'
import type { BuiltinToolRuntimeContext } from '../tool-types.js'
import { recordKnowledgeSpaceRead } from './knowledge-basis.js'

const MARKDOWN_EXTENSION = '.md'

export const readMarkdownAttachmentContent = async (
  fileService: FileService,
  attachmentId: string,
  organizationId: string,
): Promise<string | null> => {
  const opened = await fileService.openStream(attachmentId, organizationId)
  if (!opened) return null
  const source = await readCanonicalMarkdownAttachment(
    async () => opened.stream,
    attachmentId,
    organizationId,
  )
  return source.content
}

/**
 * Read a `.md` document node's current text.
 *
 * Shared by the live editor's base-document load and the edit tool's save, so
 * the text a person watches being changed and the text the edits are applied
 * to are read the same way — a second reader here would be a second chance to
 * disagree about what the document currently says.
 */
export const readMarkdownDocument = async (
  prisma: PrismaClient,
  fileService: FileService,
  organizationId: string,
  pageId: string,
  disclosureContext: Pick<BuiltinToolRuntimeContext, 'consumedSources'>,
): Promise<{
  attachmentId: string
  content: string
  parentPageId: string | null
  spaceId: string
  title: string
} | null> => {
  const page = await prisma.knowledgePage.findFirst({
    select: {
      id: true,
      kind: true,
      parentPageId: true,
      spaceId: true,
      publishedVersion: { select: { attachmentId: true } },
      space: {
        select: {
          channelId: true,
          organizationId: true,
          ownerAgentId: true,
          projectId: true,
          teamId: true,
          userId: true,
          visibility: true,
        },
      },
      title: true,
      versions: {
        orderBy: { versionNumber: 'desc' },
        select: { attachmentId: true },
        take: 1,
      },
    },
    where: { deletedAt: null, id: pageId, organizationId },
  })
  if (!page || page.kind !== 'file') return null
  if (!page.title.toLowerCase().endsWith(MARKDOWN_EXTENSION)) return null

  const attachmentId = page.versions[0]?.attachmentId ?? page.publishedVersion?.attachmentId
  if (!attachmentId) return null

  // The body is about to enter the run. Record its source before opening the
  // attachment so no byte can be streamed or persisted with an empty basis.
  recordKnowledgeSpaceRead(disclosureContext, [page.space])
  const content = await readMarkdownAttachmentContent(fileService, attachmentId, organizationId)
  if (content === null) return null
  return {
    attachmentId,
    content,
    parentPageId: page.parentPageId,
    spaceId: page.spaceId,
    title: page.title,
  }
}

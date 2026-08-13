import type { PrismaClient } from '@prisma/client'
import type { FileService } from '@nessie/runtime'

const MARKDOWN_EXTENSION = '.md'

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

  const opened = await fileService.openStream(attachmentId, organizationId)
  if (!opened) return null

  const chunks: Buffer[] = []
  for await (const chunk of opened.stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array))
  }
  return {
    attachmentId,
    content: Buffer.concat(chunks).toString('utf8'),
    parentPageId: page.parentPageId,
    spaceId: page.spaceId,
    title: page.title,
  }
}

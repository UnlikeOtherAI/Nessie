import type { PrismaClient } from '@prisma/client'
import type { DisclosureViewer, FileService } from '@nessie/runtime'
import {
  canReadKnowledgePageVersion,
  isMarkdownAttachment,
  readCanonicalMarkdownAttachment,
} from '@nessie/knowledge'
import type { BuiltinToolRuntimeContext } from '../tool-types.js'
import { recordKnowledgeSpaceRead, recordKnowledgeVersionRead } from './knowledge-basis.js'

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
  disclosureContext: Pick<BuiltinToolRuntimeContext, 'consumedSources'> & {
    disclosureViewer?: DisclosureViewer
  },
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
        select: {
          attachmentId: true,
          basisScopes: { select: { scopeId: true, scopeType: true } },
          disclosureSources: { select: { sourceAuthorUserId: true, sourceChannelId: true } },
        },
      },
    },
    where: { deletedAt: null, id: pageId, organizationId },
  })
  if (!page || page.kind !== 'file') return null
  // The live composer receives both a page title and source bytes. Preserve
  // the all-retained-version rule used by ordinary page envelopes before
  // either reaches the run context.
  if (!disclosureContext.disclosureViewer || !page.versions.every((version) =>
    canReadKnowledgePageVersion(version, disclosureContext.disclosureViewer!),
  )) return null

  const version = page.versions[0]
  const attachmentId = version?.attachmentId
  if (!attachmentId) return null

  // The body is about to enter the run. Record its source before opening the
  // attachment so no byte can be streamed or persisted with an empty basis.
  // An envelope shows title/history together, so every retained version's
  // provenance accompanies the admitted read as well.
  recordKnowledgeSpaceRead(disclosureContext, [page.space])
  for (const retainedVersion of page.versions) {
    recordKnowledgeVersionRead(disclosureContext, retainedVersion)
  }
  const opened = await fileService.openStream(attachmentId, organizationId)
  if (!opened || !isMarkdownAttachment(opened.attachment)) return null
  const source = await readCanonicalMarkdownAttachment(
    async () => opened.stream,
    attachmentId,
    organizationId,
  )
  return {
    attachmentId,
    content: source.content,
    parentPageId: page.parentPageId,
    spaceId: page.spaceId,
    title: page.title,
  }
}

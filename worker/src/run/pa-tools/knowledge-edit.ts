import { Readable } from 'node:stream'
import { attributionFromActorContext } from '@nessie/runtime'
import { canWriteSpace, loadSpaceViewer } from '@nessie/knowledge'
import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import { fileServiceFor } from '../file-service.js'
import { applyDocumentEdits } from '../execute/document-stream-edit.js'
import { buildSpaceViewerPrincipal } from './access.js'
import { createWorkerKnowledgeProvider } from './knowledge-provider.js'
import { readMarkdownDocument } from './knowledge-document-io.js'

const MAX_BODY_CHARS = 200_000
const MARKDOWN_MIME = 'text/markdown'

type EditInput = {
  pageId?: string
  changeComment?: string
  edits?: { find?: string; replace?: string }[]
}

/**
 * Apply targeted edits to an existing `.md` document.
 *
 * The person has been watching each change land in place, so the same two
 * guarantees the compose path makes hold here: the saved file must equal what
 * they watched, and a Stop must beat a save that had not started.
 */
export const runKbDocumentEditTool = async (
  context: BuiltinToolRuntimeContext,
  input: EditInput,
): Promise<ToolExecutionResult> => {
  const pageId = input.pageId?.trim()
  if (!pageId) {
    throw new Error('pageId is required.')
  }
  const rawEdits = input.edits ?? []
  if (rawEdits.length === 0) {
    throw new Error('edits is required and must contain at least one change.')
  }
  const edits = rawEdits.map((edit, index) => {
    if (typeof edit?.find !== 'string' || edit.find.length === 0) {
      throw new Error(`Edit ${index + 1} is missing "find".`)
    }
    return { find: edit.find, replace: typeof edit.replace === 'string' ? edit.replace : '' }
  })

  const organizationId = String(context.channel.organizationId)
  const fileService = fileServiceFor(context.prisma)
  const document = await readMarkdownDocument(context.prisma, fileService, organizationId, pageId)
  if (!document) {
    throw new Error(
      `No markdown document found for pageId=${pageId}. `
      + 'kb_document_edit only edits .md file documents.',
    )
  }

  const provider = createWorkerKnowledgeProvider(context)
  const page = await provider.getPage(organizationId, pageId)
  if (!page) {
    throw new Error(`Knowledge page not found: ${pageId}`)
  }
  const space = await provider.getSpace(organizationId, page.spaceId)
  if (!space) {
    throw new Error(`Knowledge space not found: ${page.spaceId}`)
  }
  const principal = buildSpaceViewerPrincipal(context)
  if (principal.actorType === 'agent' && space.sensitivityTier === 'restricted') {
    throw new Error('Agents may not write to a restricted knowledge space.')
  }
  const viewer = await loadSpaceViewer(context.prisma, organizationId, principal)
  if (!canWriteSpace(space, viewer)) {
    throw new Error('You do not have write access to this knowledge space.')
  }

  // Applied independently of the streaming preview, so the two agreeing is a
  // real check rather than a restatement.
  const { applied } = applyDocumentEdits(document.content, edits)
  if (applied.length > MAX_BODY_CHARS) {
    throw new Error(`A document may be at most ${MAX_BODY_CHARS} characters.`)
  }
  if (applied === document.content) {
    throw new Error('Those edits leave the document unchanged.')
  }

  const recorder = context.documentStream
  const session = context.toolCallId
    ? await recorder?.settle(context.toolCallId) ?? null
    : null
  if (session && session.markdown !== applied) {
    await recorder?.finalizeOutstanding('save_failed')
    throw new Error(
      'The edits shown live did not match the edits applied, so nothing was saved. '
      + 'Re-read the document and try again.',
    )
  }

  if (session) {
    const claimed = await context.prisma.runDocumentSession.updateMany({
      data: { status: 'saving' },
      where: { id: session.sessionId, status: 'streaming' },
    })
    if (claimed.count === 0) {
      throw new Error('This edit was stopped before it could be saved.')
    }
  }

  const attribution = attributionFromActorContext(context.actorContext)
  const { attachment } = await fileService.store({
    attribution,
    body: Readable.from([Buffer.from(applied, 'utf8')]),
    filename: document.title,
    mime: MARKDOWN_MIME,
    organizationId,
    scope: { projectId: space.projectId, spaceId: space.id, teamId: space.teamId },
    uploaderId: context.actorContext.actor.actorId,
  })

  try {
    const version = await provider.addFileVersion({
      attachmentId: attachment.id,
      authorId: context.agentId,
      authorType: 'agent',
      changeComment: input.changeComment ?? null,
      organizationId,
      pageId,
    })
    const versionNumber = version?.versionNumber ?? null

    if (session) {
      await context.prisma.runDocumentSession.update({
        data: {
          attachmentId: attachment.id,
          chars: applied.length,
          finishedAt: new Date(),
          pageId,
          status: 'saved',
          versionNumber,
        },
        where: { id: session.sessionId },
      })
    }

    const delta = applied.length - document.content.length
    return {
      inputSummary: `pageId=${pageId} edits=${edits.length}`,
      outputPreview:
        `Applied ${edits.length} edit${edits.length === 1 ? '' : 's'} to "${document.title}" `
        + `(${delta >= 0 ? '+' : ''}${delta} characters, now ${applied.length}). `
        + `pageId=${pageId}${versionNumber ? `, version ${versionNumber}` : ''}.`,
      toolName: 'kb_document_edit',
    }
  } catch (error) {
    // Never leave bytes behind that no version points at.
    await fileService
      .delete(attachment.id, organizationId, attribution)
      .catch(() => undefined)
    throw error
  }
}

import { Readable } from 'node:stream'
import { attributionFromActorContext, type FileService } from '@nessie/runtime'
import {
  canWriteSpace,
  loadSpaceViewer,
  type KnowledgeProvider,
} from '@nessie/knowledge'
import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import { fileServiceFor } from '../file-service.js'
import { applyDocumentEdits } from '../execute/document-stream-edit.js'
import { buildSpaceViewerPrincipal } from './access.js'
import { createWorkerKnowledgeProvider } from './knowledge-provider.js'
import {
  recordKnowledgeSpaceRead,
  sourcesOutsideAgentDocumentAudience,
} from './knowledge-basis.js'
import { readMarkdownDocument } from './knowledge-document-io.js'

const MAX_BODY_CHARS = 200_000
const MARKDOWN_MIME = 'text/markdown'

type EditInput = {
  pageId?: string
  changeComment?: string
  edits?: { find?: string; replace?: string }[]
}

type EditDependencies = {
  files?: FileService
  provider?: KnowledgeProvider
  readDocument?: typeof readMarkdownDocument
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
  dependencies: EditDependencies = {},
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
  const fileService = dependencies.files ?? fileServiceFor(context.prisma)
  const document = await (dependencies.readDocument ?? readMarkdownDocument)(
    context.prisma,
    fileService,
    organizationId,
    pageId,
  )
  if (!document) {
    throw new Error(
      `No markdown document found for pageId=${pageId}. `
      + 'kb_document_edit only edits .md file documents.',
    )
  }

  const provider = dependencies.provider ?? createWorkerKnowledgeProvider(context)
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
  // The whole document body is now in the run's context.
  recordKnowledgeSpaceRead(context, [space])

  const viewer = await loadSpaceViewer(context.prisma, organizationId, principal)
  if (!canWriteSpace(space, viewer)) {
    throw new Error('You do not have write access to this knowledge space.')
  }

  if (
    space.ownerAgentId !== null
    && sourcesOutsideAgentDocumentAudience(context, {
      organizationId: space.organizationId,
      ownerAgentId: space.ownerAgentId,
    }).length > 0
  ) {
    // Knowledge-base reads do not gate on page status, so neither a draft nor
    // a new unpublished version can safely hold a wider-audience disclosure.
    await context.documentStream?.finalizeOutstanding('save_failed')
    return {
      inputSummary: `pageId=${pageId} edits=${edits.length}`,
      outputPreview:
        'I cannot save this version because this run used material that the document audience '
        + 'cannot access. Write a version without that material, or choose a destination whose '
        + 'audience already has access to it. The existing document is unchanged.',
      toolName: 'kb_document_edit',
    }
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
    // Unsafe agent-owned writes returned above. A page that was already a draft
    // never becomes published here.
    const published = space.ownerAgentId !== null
      && page.status === 'published'
    if (published) {
      await provider.publishPage({
        actorUserId: context.actorContext.actionContext.effectiveUserId ?? null,
        organizationId,
        pageId,
      })
    }

    if (session) {
      await context.prisma.runDocumentSession.update({
        data: {
          attachmentId: attachment.id,
          chars: applied.length,
          finishedAt: new Date(),
          pageId,
          ...(space.ownerAgentId !== null ? { published } : {}),
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
        + `pageId=${pageId}${versionNumber ? `, version ${versionNumber}` : ''}.`
        + (space.ownerAgentId === null
          ? ''
          : published
              ? ' The new version is published in that agent-owned space.'
              : ' The page was already a draft, so the new version remains a draft; '
                + 'call kb_publish_request when it is ready for review.'),
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

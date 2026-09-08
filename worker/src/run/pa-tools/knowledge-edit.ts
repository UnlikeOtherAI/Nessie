import { Readable } from 'node:stream'
import { attributionFromActorContext, type FileService } from '@nessie/runtime'
import {
  canWriteSpace,
  loadSpaceViewer,
  type KnowledgeProvider,
} from '@nessie/knowledge'
import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import { fileServiceFor } from '../file-service.js'
import { settleDocumentSession } from '../execute/document-session-claim.js'
import { applyDocumentEdits } from '../execute/document-stream-edit.js'
import { buildSpaceViewerPrincipal } from './access.js'
import { createWorkerKnowledgeProvider } from './knowledge-provider.js'
import { recordKnowledgeSpaceRead, versionDisclosureFromConsumedSources } from './knowledge-basis.js'
import {
  canReadPageVersions,
  recordPageVersionRead,
  resolveKnowledgeDisclosureViewer,
} from './knowledge.js'
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
  const disclosureViewer = await resolveKnowledgeDisclosureViewer(context)
  if (principal.actorType === 'agent' && space.sensitivityTier === 'restricted') {
    throw new Error('Agents may not write to a restricted knowledge space.')
  }
  // The whole document body is now in the run's context.
  recordKnowledgeSpaceRead(context, [space])

  const viewer = await loadSpaceViewer(context.prisma, organizationId, principal)
  if (!canWriteSpace(space, viewer)) {
    throw new Error('You do not have write access to this knowledge space.')
  }
  if (!(await canReadPageVersions(context, page, disclosureViewer))) {
    throw new Error('You do not have access to this knowledge page.')
  }
  recordPageVersionRead(context, page)

  const document = await (dependencies.readDocument ?? readMarkdownDocument)(
    context.prisma,
    fileService,
    organizationId,
    pageId,
    { ...context, disclosureViewer },
  )
  if (!document) {
    throw new Error(
      `No markdown document found for pageId=${pageId}. `
      + 'kb_document_edit only edits .md file documents.',
    )
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

  // Claimed before anything is written, and fenced on the session's claim as
  // well as its status, so an executor whose run was taken over stops here
  // rather than after it has stored an attachment and added a version.
  if (session) {
    const claimed = await settleDocumentSession(context.prisma, {
      claimToken: session.claimToken,
      data: { status: 'saving' },
      from: ['streaming'],
      sessionId: session.sessionId,
      settle: 'claim for saving',
    })
    if (claimed === 'superseded') {
      throw new Error(
        'Another executor has taken this run over, so this edit was not saved here.',
      )
    }
    if (claimed !== 'applied') {
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
      ...versionDisclosureFromConsumedSources(context),
      organizationId,
      pageId,
    })
    const versionNumber = version?.versionNumber ?? null
    // The saved version retains the run basis. A page that was already a draft
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

    // Fenced on the claim alone, never on the status: the new version exists by
    // the time this runs, so a status written by somebody else in the meantime
    // is the stale fact. See `execute/document-session-claim.ts`.
    const settled = session
      ? await settleDocumentSession(context.prisma, {
        claimToken: session.claimToken,
        data: {
          attachmentId: attachment.id,
          chars: applied.length,
          finishedAt: new Date(),
          pageId,
          ...(space.ownerAgentId !== null ? { published } : {}),
          status: 'saved',
          versionNumber,
        },
        sessionId: session.sessionId,
        settle: 'save',
      })
      : 'applied'

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
                + 'call kb_publish_request when it is ready for review.')
        + (settled === 'superseded'
          ? ' Another executor took this run over while the version was being filed, so the '
            + 'document window may still show it as interrupted; the version itself is saved.'
          : ''),
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

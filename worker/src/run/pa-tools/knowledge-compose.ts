import { Readable } from 'node:stream'
import { attributionFromActorContext, type FileService } from '@nessie/runtime'
import {
  canWriteSpace,
  loadSpaceViewer,
  type KnowledgeProvider,
} from '@nessie/knowledge'
import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import { settleDocumentSession } from '../execute/document-session-claim.js'
import { fileServiceFor } from '../file-service.js'
import { buildSpaceViewerPrincipal } from './access.js'
import { versionDisclosureFromConsumedSources } from './knowledge-basis.js'
import { createWorkerKnowledgeProvider } from './knowledge-provider.js'

const MAX_BODY_CHARS = 200_000
const MAX_LABELS = 16
const MARKDOWN_MIME = 'text/markdown'

/** Filenames are the title plus `.md`, with path separators neutralised. */
const toMarkdownFilename = (title: string): string => {
  const base = title.replace(/[/\\]/g, '-').trim() || 'document'
  return base.toLowerCase().endsWith('.md') ? base : `${base}.md`
}

type ComposeInput = {
  spaceId?: string
  parentPageId?: string
  title?: string
  summary?: string
  labels?: string[]
  taskId?: string
  changeComment?: string
  markdown?: string
}

type ComposeDependencies = {
  files?: FileService
  provider?: KnowledgeProvider
}

/**
 * Write a markdown document and save it as a `.md` file node.
 *
 * The person watching the popup has already seen this document arrive, so the
 * two things this must guarantee above all are that the file matches what they
 * watched, and that a Stop they pressed wins over a save that had not started.
 * Both are settled here rather than hoped for: the streamed text is compared
 * byte-for-byte with the parsed argument, and the session is claimed with a
 * conditional update that a cancellation can lose or win but never tie.
 *
 * A third thing it must not do is write the session at all once another worker
 * has taken the run over. Both session writes below therefore ride the
 * session's claim (`../execute/document-session-claim.ts`) — and the save rides
 * the claim ALONE, never the status, because by then the document is filed.
 */
export const runKbDocumentComposeTool = async (
  context: BuiltinToolRuntimeContext,
  input: ComposeInput,
  dependencies: ComposeDependencies = {},
): Promise<ToolExecutionResult> => {
  const markdown = input.markdown ?? ''
  if (!markdown.trim()) {
    throw new Error('markdown is required and must contain the document body.')
  }
  if (markdown.length > MAX_BODY_CHARS) {
    throw new Error(`A document may be at most ${MAX_BODY_CHARS} characters.`)
  }
  if (input.labels && input.labels.length > MAX_LABELS) {
    throw new Error(`A document may carry at most ${MAX_LABELS} labels.`)
  }
  if (!input.title?.trim()) {
    throw new Error('title is required.')
  }

  const organizationId = String(context.channel.organizationId)
  const recorder = context.documentStream
  const session = context.toolCallId
    ? await recorder?.settle(context.toolCallId) ?? null
    : null

  // What the person watched must be what gets saved. The scanner that produced
  // the live text and `JSON.parse` that produced these arguments are different
  // readers of the same bytes; if they disagree, the safe move is to save
  // nothing rather than file a document nobody reviewed.
  if (session && session.markdown !== markdown) {
    await recorder?.finalizeOutstanding('save_failed')
    throw new Error(
      'The streamed document did not match the final arguments, so nothing was saved. '
      + 'Write the document again.',
    )
  }

  // A destination the person picked from the popup's address bar overrides the
  // one agreed in chat: their last click is the most recent instruction.
  const stored = session
    ? await context.prisma.runDocumentSession.findUnique({
      select: { overrideParentPageId: true, overrideSpaceId: true },
      where: { id: session.sessionId },
    })
    : null
  const spaceId = stored?.overrideSpaceId ?? input.spaceId
  const parentPageId = stored?.overrideSpaceId
    ? stored.overrideParentPageId
    : input.parentPageId ?? null
  if (!spaceId) {
    throw new Error('spaceId is required.')
  }

  const provider = dependencies.provider ?? createWorkerKnowledgeProvider(context)
  const principal = buildSpaceViewerPrincipal(context)
  const space = await provider.getSpace(organizationId, spaceId)
  if (!space) {
    throw new Error(`Knowledge space not found: ${spaceId}`)
  }
  if (principal.actorType === 'agent' && space.sensitivityTier === 'restricted') {
    throw new Error('Agents may not write to a restricted knowledge space.')
  }
  const viewer = await loadSpaceViewer(context.prisma, organizationId, principal)
  if (!canWriteSpace(space, viewer)) {
    throw new Error('You do not have write access to this knowledge space.')
  }

  // A ticket is a project-owned scope. Resolve it before claiming the session
  // or storing an attachment so a document can never be filed against a
  // ticket from another project just because the destination is writable.
  if (input.taskId) {
    const task = await context.prisma.task.findFirst({
      where: {
        id: input.taskId,
        organizationId,
        projectId: space.projectId,
      },
      select: { id: true },
    })
    if (!task) throw new Error('Ticket not found in this knowledge space project.')
  }

  // Claim the session before writing anything. A Stop that already flipped the
  // run loses the claim and nothing is saved; a Stop arriving after it only
  // cancels the rest of the run. Fenced on the session's claim too, so an
  // executor whose run was taken over stops here rather than at the save,
  // before it stores an attachment or creates a page.
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
        'Another executor has taken this run over, so this document was not saved here.',
      )
    }
    if (claimed !== 'applied') {
      throw new Error('This document was stopped before it could be saved.')
    }
  }

  const fileService = dependencies.files ?? fileServiceFor(context.prisma)
  const attribution = attributionFromActorContext(context.actorContext)
  const filename = toMarkdownFilename(input.title)
  const { attachment } = await fileService.store({
    attribution,
    body: Readable.from([Buffer.from(markdown, 'utf8')]),
    filename,
    mime: MARKDOWN_MIME,
    organizationId,
    scope: { projectId: space.projectId, spaceId: space.id, teamId: space.teamId },
    uploaderId: context.actorContext.actor.actorId,
  })

  try {
    const page = await provider.createPage({
      attachmentId: attachment.id,
      authorId: context.agentId,
      authorType: 'agent',
      changeComment: input.changeComment ?? null,
      createdBy: context.agentId,
      kind: 'file',
      ...versionDisclosureFromConsumedSources(context),
      labels: input.labels,
      organizationId,
      parentPageId: parentPageId ?? undefined,
      projectId: space.projectId,
      spaceId,
      summary: input.summary ?? null,
      taskId: input.taskId ?? null,
      title: filename,
    })

    // The immutable version has the run's source basis, so publish remains safe
    // for the subset of this home that may read it.
    const published = space.visibility === 'private'
    if (published) {
      await provider.publishPage({
        actorUserId: context.actorContext.actionContext.effectiveUserId ?? null,
        organizationId,
        pageId: page.id,
      })
    }

    const versionNumber = page.latestVersion?.versionNumber ?? 1
    // Deliberately NOT conditional on the session still being `saving`. The
    // document exists by now, so a status this executor lost a race over is the
    // stale fact, not this write — the fence is the claim alone. What a refusal
    // leaves behind, and why the page stays, is in `document-session-claim.ts`.
    const settled = session
      ? await settleDocumentSession(context.prisma, {
        claimToken: session.claimToken,
        data: {
          attachmentId: attachment.id,
          chars: markdown.length,
          finishedAt: new Date(),
          pageId: page.id,
          published,
          status: 'saved',
          versionNumber,
        },
        sessionId: session.sessionId,
        settle: 'save',
      })
      : 'applied'

    return {
      inputSummary: `spaceId=${spaceId} title=${filename}`,
      outputPreview:
        `Saved "${filename}" (${markdown.length} characters) to space "${space.name}"`
        + `${stored?.overrideSpaceId ? ' — the person moved it there from the document window' : ''}`
        + `. pageId=${page.id}, version ${versionNumber}. `
        + (published
          ? 'It is published in that private space.'
          : 'It is a draft; call kb_publish_request when it is ready for review.')
        + (settled === 'superseded'
          ? ' Another executor took this run over while the document was being filed, so the '
            + 'document window may still show it as interrupted; the document itself is saved.'
          : ''),
      toolName: 'kb_document_compose',
    }
  } catch (error) {
    // Never leave bytes behind that no page points at.
    await fileService
      .delete(attachment.id, organizationId, attribution)
      .catch(() => undefined)
    throw error
  }
}

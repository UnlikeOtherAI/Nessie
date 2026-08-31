import { Readable } from 'node:stream'
import { attributionFromActorContext, type FileService } from '@nessie/runtime'
import {
  canWriteSpace,
  loadSpaceViewer,
  type KnowledgeProvider,
} from '@nessie/knowledge'
import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import { fileServiceFor } from '../file-service.js'
import { buildSpaceViewerPrincipal } from './access.js'
import { sourcesOutsideAgentDocumentAudience } from './knowledge-basis.js'
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

  if (
    space.ownerAgentId !== null
    && sourcesOutsideAgentDocumentAudience(context, {
      organizationId: space.organizationId,
      ownerAgentId: space.ownerAgentId,
    }).length > 0
  ) {
    // Knowledge-base reads do not gate on page status, so a draft would expose
    // its body and attachment to the agent's whole audience. Refuse before any
    // attachment, page, or version can be written instead.
    await recorder?.finalizeOutstanding('save_failed')
    return {
      inputSummary: `spaceId=${spaceId} title=${toMarkdownFilename(input.title)}`,
      outputPreview:
        'I cannot save this document because this run used material that its audience cannot '
        + 'access. Write a version without that material, or choose a destination whose audience '
        + 'already has access to it. Nothing was saved.',
      toolName: 'kb_document_compose',
    }
  }

  // Claim the session before writing anything. A Stop that already flipped the
  // run loses the claim and nothing is saved; a Stop arriving after it only
  // cancels the rest of the run.
  if (session) {
    const claimed = await context.prisma.runDocumentSession.updateMany({
      data: { status: 'saving' },
      where: { id: session.sessionId, status: 'streaming' },
    })
    if (claimed.count === 0) {
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
      labels: input.labels,
      organizationId,
      parentPageId: parentPageId ?? undefined,
      projectId: space.projectId,
      spaceId,
      summary: input.summary ?? null,
      taskId: input.taskId ?? null,
      title: filename,
    })

    // The covered-audience check above rejects unsafe agent-owned writes.
    // Ordinary private spaces retain their historical auto-publish behaviour.
    const published = space.visibility === 'private'
    if (published) {
      await provider.publishPage({
        actorUserId: context.actorContext.actionContext.effectiveUserId ?? null,
        organizationId,
        pageId: page.id,
      })
    }

    const versionNumber = page.latestVersion?.versionNumber ?? 1
    if (session) {
      await context.prisma.runDocumentSession.update({
        data: {
          attachmentId: attachment.id,
          chars: markdown.length,
          finishedAt: new Date(),
          pageId: page.id,
          published,
          status: 'saved',
          versionNumber,
        },
        where: { id: session.sessionId },
      })
    }

    return {
      inputSummary: `spaceId=${spaceId} title=${filename}`,
      outputPreview:
        `Saved "${filename}" (${markdown.length} characters) to space "${space.name}"`
        + `${stored?.overrideSpaceId ? ' — the person moved it there from the document window' : ''}`
        + `. pageId=${page.id}, version ${versionNumber}. `
        + (published
          ? 'It is published in that private space.'
          : 'It is a draft; call kb_publish_request when it is ready for review.'),
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

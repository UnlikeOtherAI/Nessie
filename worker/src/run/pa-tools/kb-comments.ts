import {
  computeAnchor,
  createAnnotationService,
  createNativeKnowledgeProvider,
  findAnnotationLocation,
  htmlToPlainText,
  loadSpaceViewer,
  type AnnotationAccess,
  type AnnotationActor,
  type AnnotationRecord,
  type SpaceViewerPrincipal,
} from '@nessie/knowledge'
import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import { resolveEffectiveUserId } from './access.js'
import { truncate } from './tool-output.js'

// A delegating PA authors as its owning user (with the agent recorded); an
// autonomous agent authors as itself. Mirrors message authorship.
const buildActor = (context: BuiltinToolRuntimeContext): AnnotationActor => {
  const effectiveUserId = resolveEffectiveUserId(context)
  return effectiveUserId
    ? { authorType: 'user', authorId: effectiveUserId, delegatedByAgentId: context.agentId }
    : { authorType: 'agent', authorId: context.agentId }
}

// A delegating PA (personal assistant acting for its owner) reads/writes with
// the owner's own space access, same as buildActor above; an autonomous agent
// is checked against its own channel bindings / explicit space grants — no
// more blanket bypass for either case.
const buildPrincipal = (context: BuiltinToolRuntimeContext): SpaceViewerPrincipal => {
  const effectiveUserId = resolveEffectiveUserId(context)
  return effectiveUserId
    ? { actorType: 'user', actorId: effectiveUserId }
    : { actorType: 'agent', actorId: context.agentId }
}

const loadPageAccess = async (context: BuiltinToolRuntimeContext, pageId: string) => {
  const organizationId = String(context.channel.organizationId)
  const provider = createNativeKnowledgeProvider(context.prisma)
  const page = await provider.getPage(organizationId, pageId)
  if (!page) throw new Error(`Knowledge page not found: ${pageId}`)
  const space = await provider.getSpace(organizationId, page.spaceId)
  if (!space) throw new Error(`Knowledge space not found for page: ${pageId}`)
  const viewer = await loadSpaceViewer(context.prisma, organizationId, buildPrincipal(context))
  const access: AnnotationAccess = {
    space,
    viewer,
    organizationId,
    pageId: page.id,
    spaceId: page.spaceId,
  }
  return { access, page }
}

const resolveAccessForAnnotation = async (
  context: BuiltinToolRuntimeContext,
  annotationId: string,
) => {
  const location = await findAnnotationLocation(
    context.prisma,
    String(context.channel.organizationId),
    annotationId,
  )
  if (!location) throw new Error(`Annotation not found: ${annotationId}`)
  return loadPageAccess(context, location.pageId)
}

const formatItem = (item: AnnotationRecord): string => {
  const author = item.authorType === 'agent' ? `agent:${item.authorId}` : `user:${item.authorId}`
  const quote = item.anchor ? ` quote="${truncate(item.anchor.quote, 60)}"` : ''
  const orphan = item.orphaned ? ' [orphaned]' : ''
  return [
    `- [${item.kind}/${item.state}] id=${item.id} by ${author}${quote}${orphan}`,
    `  ${truncate(item.body, 200)}`,
    item.replies.length ? `  (${item.replies.length} repl${item.replies.length === 1 ? 'y' : 'ies'})` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

export const runKbCommentsListTool = async (
  context: BuiltinToolRuntimeContext,
  input: { pageId: string; kind?: 'comment' | 'note' },
): Promise<ToolExecutionResult> => {
  const { access } = await loadPageAccess(context, input.pageId)
  const service = createAnnotationService({ prisma: context.prisma })
  const items = await service.listForPage(access, input.kind ? { kind: input.kind } : undefined)
  const outputPreview = items.length
    ? items.map(formatItem).join('\n')
    : 'No comments or notes on this page yet.'
  return { inputSummary: `pageId=${input.pageId}`, outputPreview, toolName: 'kb_comments_list' }
}

export const runKbCommentAddTool = async (
  context: BuiltinToolRuntimeContext,
  input: { pageId: string; body: string },
): Promise<ToolExecutionResult> => {
  const { access } = await loadPageAccess(context, input.pageId)
  const service = createAnnotationService({ prisma: context.prisma })
  const created = await service.createComment(access, { body: input.body, actor: buildActor(context) })
  return {
    inputSummary: `pageId=${input.pageId}`,
    outputPreview: `Added comment id=${created.id}`,
    toolName: 'kb_comment_add',
  }
}

export const runKbNoteAddTool = async (
  context: BuiltinToolRuntimeContext,
  input: { pageId: string; quote: string; body: string },
): Promise<ToolExecutionResult> => {
  const { access, page } = await loadPageAccess(context, input.pageId)
  const plain = htmlToPlainText(page.latestVersion?.body ?? '')
  const offset = plain.indexOf(input.quote)
  if (offset < 0) {
    throw new Error('The quote was not found verbatim in the current page body.')
  }
  const anchor = computeAnchor(plain, input.quote, offset)
  if (!anchor) throw new Error('Could not anchor the note to the provided quote.')
  const service = createAnnotationService({ prisma: context.prisma })
  const created = await service.createNote(access, {
    body: input.body,
    anchor,
    anchorVersionId: page.latestVersion?.id ?? null,
    actor: buildActor(context),
  })
  return {
    inputSummary: `pageId=${input.pageId} quote="${truncate(input.quote, 60)}"`,
    outputPreview: `Added note id=${created.id}`,
    toolName: 'kb_note_add',
  }
}

export const runKbCommentReplyTool = async (
  context: BuiltinToolRuntimeContext,
  input: { annotationId: string; body: string },
): Promise<ToolExecutionResult> => {
  const { access } = await resolveAccessForAnnotation(context, input.annotationId)
  const service = createAnnotationService({ prisma: context.prisma })
  const created = await service.reply(access, {
    parentId: input.annotationId,
    body: input.body,
    actor: buildActor(context),
  })
  return {
    inputSummary: `annotationId=${input.annotationId}`,
    outputPreview: `Replied id=${created.id}`,
    toolName: 'kb_comment_reply',
  }
}

export const runKbCommentResolveTool = async (
  context: BuiltinToolRuntimeContext,
  input: { annotationId: string; state?: 'resolved' | 'open' },
): Promise<ToolExecutionResult> => {
  const { access } = await resolveAccessForAnnotation(context, input.annotationId)
  const service = createAnnotationService({ prisma: context.prisma })
  const updated = await service.setState(access, {
    annotationId: input.annotationId,
    state: input.state ?? 'resolved',
    actor: buildActor(context),
  })
  return {
    inputSummary: `annotationId=${input.annotationId}`,
    outputPreview: `Set state=${updated.state} id=${updated.id}`,
    toolName: 'kb_comment_resolve',
  }
}

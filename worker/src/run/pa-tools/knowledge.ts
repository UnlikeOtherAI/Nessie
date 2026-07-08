import {
  canReadSpace,
  createNativeKnowledgeProvider,
  htmlToPlainText,
  loadSpaceViewer,
  mapPage,
  pageInclude,
  searchNativePagesHybrid,
  type KnowledgePageRecord,
  type KnowledgePageTreeNode,
  type KnowledgeSpaceRecord,
  type SpaceViewer,
} from '@nessie/knowledge'
import { attributionFromActorContext } from '@nessie/runtime'
import { KNOWLEDGE_EMBEDDING_MODEL } from '@nessie/schemas'
import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import { buildSpaceViewerPrincipal } from './access.js'
import { truncate } from './tool-output.js'

const MAX_KB_SEARCH_LIMIT = 8
const DEFAULT_KB_SEARCH_LIMIT = 5
const PAGE_BODY_CHAR_CAP = 20_000
const MAX_LIST_SPACES = 50

export const clampKbSearchLimit = (value: unknown): number => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return DEFAULT_KB_SEARCH_LIMIT
  return Math.min(Math.max(Math.trunc(parsed), 1), MAX_KB_SEARCH_LIMIT)
}

// Best-effort query embedding for the hybrid search's semantic channel. A
// missing model client (not every runtime context carries one) or a failed
// embed call degrades kb_search to lexical-only search rather than failing
// the tool call outright — never blocks the agent from searching.
const resolveQueryEmbedding = async (
  context: BuiltinToolRuntimeContext,
  query: string,
): Promise<number[] | null> => {
  if (!context.modelClient) return null
  try {
    return await context.modelClient.embed(query, {
      model: KNOWLEDGE_EMBEDDING_MODEL,
      usage: attributionFromActorContext(context.actorContext),
    })
  } catch (error) {
    console.warn('kb_search: query embedding failed, degrading to lexical-only', error)
    return null
  }
}

export const runKbSearchTool = async (
  context: BuiltinToolRuntimeContext,
  input: { query: string; spaceId?: string; projectId?: string; taskId?: string; limit?: unknown },
): Promise<ToolExecutionResult> => {
  const query = input.query.trim()
  if (!query) {
    throw new Error('query is required.')
  }

  const organizationId = String(context.channel.organizationId)
  const limit = clampKbSearchLimit(input.limit)
  const viewer = await loadSpaceViewer(
    context.prisma,
    organizationId,
    buildSpaceViewerPrincipal(context),
  )
  const queryEmbedding = await resolveQueryEmbedding(context, query)

  const result = await searchNativePagesHybrid(context.prisma, {
    organizationId,
    query,
    queryEmbedding,
    viewer,
    projectId: input.projectId,
    spaceId: input.spaceId,
    taskId: input.taskId,
    limit,
  })

  if (result.data.length === 0) {
    return {
      inputSummary: `query=${query}`,
      outputPreview: `No knowledge-base pages matched "${query}".`,
      toolName: 'kb_search',
    }
  }

  const lines = result.data.map((hit, index) =>
    [
      `${index + 1}. ${hit.page.title}`,
      `   pageId=${hit.page.id} spaceId=${hit.page.spaceId}`,
      `   ${truncate(hit.snippet, 240)}`,
    ].join('\n'),
  )

  return {
    inputSummary: `query=${query}`,
    outputPreview: lines.join('\n'),
    toolName: 'kb_search',
  }
}

const ACCESS_DENIED_MESSAGE = 'You do not have access to this knowledge page.'

export const runKbPageReadTool = async (
  context: BuiltinToolRuntimeContext,
  input: { pageId: string },
): Promise<ToolExecutionResult> => {
  const pageId = input.pageId.trim()
  if (!pageId) {
    throw new Error('pageId is required.')
  }

  const organizationId = String(context.channel.organizationId)
  const provider = createNativeKnowledgeProvider(context.prisma)
  const page = await provider.getPage(organizationId, pageId)
  if (!page) {
    return {
      inputSummary: `pageId=${pageId}`,
      outputPreview: `Knowledge page not found: ${pageId}`,
      toolName: 'kb_page_read',
    }
  }

  const space = await provider.getSpace(organizationId, page.spaceId)
  if (!space) {
    return {
      inputSummary: `pageId=${pageId}`,
      outputPreview: `Knowledge space not found for page: ${pageId}`,
      toolName: 'kb_page_read',
    }
  }

  const principal = buildSpaceViewerPrincipal(context)
  const viewer = await loadSpaceViewer(context.prisma, organizationId, principal)
  if (!canReadSpace(space, viewer)) {
    return { inputSummary: `pageId=${pageId}`, outputPreview: ACCESS_DENIED_MESSAGE, toolName: 'kb_page_read' }
  }

  // Page-level privacy beyond the space: an agent viewer never sees a page
  // that is itself restricted or privately scoped to a different agent, even
  // when the containing space is otherwise readable.
  if (principal.actorType === 'agent') {
    const deniedByTier = page.sensitivityTier === 'restricted'
    const deniedByPrivacy =
      page.privateToAgentId !== null && page.privateToAgentId !== principal.actorId
    if (deniedByTier || deniedByPrivacy) {
      return { inputSummary: `pageId=${pageId}`, outputPreview: ACCESS_DENIED_MESSAGE, toolName: 'kb_page_read' }
    }
  }

  const version = page.publishedVersion ?? page.latestVersion
  const plain = htmlToPlainText(version?.body ?? '')
  const truncated = plain.length > PAGE_BODY_CHAR_CAP
  const body = truncated
    ? `${plain.slice(0, PAGE_BODY_CHAR_CAP)}\n\n[truncated at ${PAGE_BODY_CHAR_CAP} characters]`
    : plain

  const lines = [
    `Title: ${page.title}`,
    `pageId=${page.id} spaceId=${page.spaceId} status=${page.status}`,
    `Labels: ${page.labels.length ? page.labels.join(', ') : '(none)'}`,
    '',
    body || '(This page has no content yet.)',
  ]

  return {
    inputSummary: `pageId=${pageId}`,
    outputPreview: lines.join('\n'),
    toolName: 'kb_page_read',
  }
}

// Renders a page tree as an indented outline, depth-first, following the
// provider's own ordering (parentPageId, then position, then title) for
// sibling order at every level.
const renderPageTree = (nodes: KnowledgePageTreeNode[]): string => {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const roots = nodes.filter((node) => !node.parentPageId || !byId.has(node.parentPageId))
  const lines: string[] = []
  const walk = (node: KnowledgePageTreeNode, depth: number): void => {
    lines.push(`${'  '.repeat(depth)}- ${node.title} (pageId=${node.id})`)
    for (const childId of node.childPageIds) {
      const child = byId.get(childId)
      if (child) walk(child, depth + 1)
    }
  }
  for (const root of roots) walk(root, 0)
  return lines.join('\n')
}

// Flat listing (no tree — a ticket's documents sit under one folder, not a
// space-wide hierarchy) of the pages bound to a ticket. Access is enforced
// per distinct space the returned pages belong to (cached, since in practice
// they all share the ticket's one "Project Documents" space) rather than by
// loading a SpaceViewer-filtered tree, because the KnowledgeProvider has no
// taskId-scoped list method — this queries knowledgePage directly and reuses
// the shared mapPage/pageInclude shape.
const runKbListByTaskTool = async (
  context: BuiltinToolRuntimeContext,
  organizationId: string,
  viewer: SpaceViewer,
  taskId: string,
): Promise<ToolExecutionResult> => {
  const provider = createNativeKnowledgeProvider(context.prisma)
  const rows = await context.prisma.knowledgePage.findMany({
    where: { taskId, organizationId, deletedAt: null, status: { not: 'archived' } },
    include: pageInclude,
    orderBy: [{ createdAt: 'asc' }],
  })
  const pages = rows.map((row) => mapPage(row))

  const spaceCache = new Map<string, KnowledgeSpaceRecord | null>()
  const visible: KnowledgePageRecord[] = []
  for (const page of pages) {
    let space = spaceCache.get(page.spaceId)
    if (space === undefined) {
      space = await provider.getSpace(organizationId, page.spaceId)
      spaceCache.set(page.spaceId, space)
    }
    if (space && canReadSpace(space, viewer)) visible.push(page)
  }

  if (visible.length === 0) {
    return {
      inputSummary: `taskId=${taskId}`,
      outputPreview: 'No accessible documents are filed under this ticket.',
      toolName: 'kb_list',
    }
  }
  const lines = visible.map(
    (page, index) => `${index + 1}. ${page.title} (pageId=${page.id}, kind=${page.kind})`,
  )
  return { inputSummary: `taskId=${taskId}`, outputPreview: lines.join('\n'), toolName: 'kb_list' }
}

export const runKbListTool = async (
  context: BuiltinToolRuntimeContext,
  input: { spaceId?: string; taskId?: string },
): Promise<ToolExecutionResult> => {
  const organizationId = String(context.channel.organizationId)
  const provider = createNativeKnowledgeProvider(context.prisma)
  const viewer = await loadSpaceViewer(
    context.prisma,
    organizationId,
    buildSpaceViewerPrincipal(context),
  )

  if (input.taskId) {
    return runKbListByTaskTool(context, organizationId, viewer, input.taskId)
  }

  if (!input.spaceId) {
    const result = await provider.listSpaces({ organizationId, viewer, limit: MAX_LIST_SPACES })
    if (result.data.length === 0) {
      return {
        inputSummary: 'spaces',
        outputPreview: 'No knowledge-base spaces are accessible to you.',
        toolName: 'kb_list',
      }
    }
    const lines = result.data.map(
      (space, index) => `${index + 1}. ${space.name} (spaceId=${space.id}, visibility=${space.visibility})`,
    )
    return { inputSummary: 'spaces', outputPreview: lines.join('\n'), toolName: 'kb_list' }
  }

  const spaceId = input.spaceId
  const space = await provider.getSpace(organizationId, spaceId)
  if (!space) {
    return {
      inputSummary: `spaceId=${spaceId}`,
      outputPreview: `Knowledge space not found: ${spaceId}`,
      toolName: 'kb_list',
    }
  }
  if (!canReadSpace(space, viewer)) {
    return {
      inputSummary: `spaceId=${spaceId}`,
      outputPreview: 'You do not have access to this knowledge space.',
      toolName: 'kb_list',
    }
  }

  const pages = await provider.listPages({ organizationId, spaceId })
  if (pages.length === 0) {
    return {
      inputSummary: `spaceId=${spaceId}`,
      outputPreview: `${space.name} has no pages yet.`,
      toolName: 'kb_list',
    }
  }

  return { inputSummary: `spaceId=${spaceId}`, outputPreview: renderPageTree(pages), toolName: 'kb_list' }
}

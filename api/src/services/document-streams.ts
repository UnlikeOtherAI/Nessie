import type { PrismaClient } from '@prisma/client'
import {
  canWriteSpace,
  type KnowledgeProvider,
  type SpaceViewer,
} from '@nessie/knowledge'
import {
  DocumentStreamErrorReasonSchema,
  parseRunId,
  type AuthorizedActionContext,
  type DocumentStreamDetailResponse,
  type DocumentStreamStatus,
  type DocumentStreamSummary,
  type DocumentStreamTarget,
  type SseEvent,
  type StreamDocumentTargetEvent,
} from '@nessie/schemas'
import { canUserReadRunBasis } from './run-disclosure.js'

// Read + retarget surface for live document composition (`kb_document_compose`).
// The popup bootstraps here on mount, reconnect and late join; the address bar
// writes here. Session rows and their durable markdown chunks are written by the
// worker's DocumentStreamRecorder — nothing in this file produces them.

// A thread rarely holds more than one composing document; the cap only bounds a
// pathological history read.
const DOCUMENT_STREAM_LIST_LIMIT = 50

const ACTIVE_STATUSES: DocumentStreamStatus[] = ['streaming', 'saving']

const SESSION_SELECT = {
  agentId: true,
  chars: true,
  createdAt: true,
  errorReason: true,
  id: true,
  organizationId: true,
  overrideParentPageId: true,
  overrideSpaceId: true,
  pageId: true,
  parentPageId: true,
  published: true,
  runId: true,
  spaceId: true,
  status: true,
  threadId: true,
  title: true,
  versionNumber: true,
} as const

type SessionRow = {
  agentId: string
  chars: number
  createdAt: Date
  errorReason: string | null
  id: string
  organizationId: string
  overrideParentPageId: string | null
  overrideSpaceId: string | null
  pageId: string | null
  parentPageId: string | null
  published: boolean
  runId: string
  spaceId: string | null
  status: DocumentStreamStatus
  threadId: string
  title: string | null
  versionNumber: number | null
}

type TargetNames = {
  pageTitles: Map<string, string>
  spaceNames: Map<string, string>
}

export type DocumentStreamKnowledgeAccess = {
  buildViewer: (actorContext: AuthorizedActionContext) => Promise<SpaceViewer>
  provider: Pick<KnowledgeProvider, 'getPage' | 'getSpace' | 'movePage'>
}

export type DocumentStreamActionContext = {
  actorContext: AuthorizedActionContext
  knowledge: DocumentStreamKnowledgeAccess
  publishSse: (
    threadId: string,
    event: SseEvent['event'],
    data: SseEvent['data'],
  ) => Promise<unknown>
}

export type DocumentStreamRetargetOutcome =
  | { kind: 'ok'; moved: boolean; session: DocumentStreamSummary }
  | { kind: 'not_found' }
  | { kind: 'space_not_found' }
  | { kind: 'space_forbidden' }
  | { kind: 'parent_not_found' }
  | { kind: 'page_missing' }
  | { kind: 'cross_space_move' }
  | { kind: 'wrong_status'; status: DocumentStreamStatus }

// The user's last click beats the model's earlier argument, so the override
// pair — never a mix of the two — is the effective target once it is set.
const effectiveTarget = (row: SessionRow): { parentPageId: string | null; spaceId: string | null } =>
  row.overrideSpaceId
    ? { parentPageId: row.overrideParentPageId, spaceId: row.overrideSpaceId }
    : { parentPageId: row.parentPageId, spaceId: row.spaceId }

const resolveTargetNames = async (
  prisma: PrismaClient,
  organizationId: string,
  rows: SessionRow[],
): Promise<TargetNames> => {
  const targets = rows.map(effectiveTarget)
  const spaceIds = [...new Set(targets.map((target) => target.spaceId).filter(
    (id): id is string => id !== null,
  ))]
  const pageIds = [...new Set(targets.map((target) => target.parentPageId).filter(
    (id): id is string => id !== null,
  ))]

  const [spaces, pages] = await Promise.all([
    spaceIds.length > 0
      ? prisma.knowledgeSpace.findMany({
          where: { id: { in: spaceIds }, organizationId },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
    pageIds.length > 0
      ? prisma.knowledgePage.findMany({
          where: { id: { in: pageIds }, organizationId },
          select: { id: true, title: true },
        })
      : Promise.resolve([]),
  ])

  return {
    pageTitles: new Map(pages.map((page) => [page.id, page.title])),
    spaceNames: new Map(spaces.map((space) => [space.id, space.name])),
  }
}

const toTarget = (row: SessionRow, names: TargetNames): DocumentStreamTarget => {
  const target = effectiveTarget(row)
  return {
    parentPageId: target.parentPageId,
    parentTitle: target.parentPageId ? names.pageTitles.get(target.parentPageId) ?? null : null,
    spaceId: target.spaceId,
    spaceName: target.spaceId ? names.spaceNames.get(target.spaceId) ?? null : null,
  }
}

const toSummary = (row: SessionRow, names: TargetNames): DocumentStreamSummary => {
  // `error_reason` is a free-text column so the worker's classification can grow
  // without a migration; anything outside the shared enum is reported as absent
  // rather than failing the response the popup depends on.
  const errorReason = DocumentStreamErrorReasonSchema.safeParse(row.errorReason)
  return {
    agentId: row.agentId,
    chars: row.chars,
    errorReason: errorReason.success ? errorReason.data : null,
    pageId: row.pageId,
    published: row.published,
    runId: row.runId,
    sessionId: row.id,
    startedAt: row.createdAt.toISOString(),
    status: row.status,
    target: toTarget(row, names),
    title: row.title,
    versionNumber: row.versionNumber,
  }
}

/**
 * A document stream is material derived from its run, so it inherits that
 * run's basis exactly like the durable thought log. Resolve each run once even
 * when it produced several sessions, then omit unreadable rows before target
 * names or chunks are loaded. Omission is the list form of "not found": it does
 * not confirm that restricted document content exists.
 */
const filterRowsByRunBasis = async (
  prisma: PrismaClient,
  input: { organizationId: string; userId: string },
  rows: SessionRow[],
): Promise<SessionRow[]> => {
  const runIds = [...new Set(rows.map((row) => row.runId))]
  const readableByRunId = new Map(await Promise.all(runIds.map(async (runId) => [
    runId,
    await canUserReadRunBasis(prisma, {
      organizationId: input.organizationId,
      runId,
      userId: input.userId,
    }),
  ] as const)))
  return rows.filter((row) => readableByRunId.get(row.runId) === true)
}

/**
 * Every composing/composed document of one thread, newest first.
 *
 * The caller has already been authorized against the thread; the organization
 * is re-asserted here so a session row can never be read across tenants.
 */
export const listThreadDocumentStreams = async (
  prisma: PrismaClient,
  input: { activeOnly?: boolean; organizationId: string; threadId: string; userId: string },
): Promise<DocumentStreamSummary[]> => {
  const rows = await prisma.runDocumentSession.findMany({
    where: {
      organizationId: input.organizationId,
      threadId: input.threadId,
      ...(input.activeOnly ? { status: { in: ACTIVE_STATUSES } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: DOCUMENT_STREAM_LIST_LIMIT,
    select: SESSION_SELECT,
  })

  const readableRows = await filterRowsByRunBasis(prisma, input, rows)
  const names = await resolveTargetNames(prisma, input.organizationId, readableRows)
  return readableRows.map((row) => toSummary(row, names))
}

const findSession = async (
  prisma: PrismaClient,
  input: { organizationId: string; sessionId: string; threadId: string },
): Promise<SessionRow | null> =>
  // `sessionId` is a global UUID: the thread gate alone would let any
  // authenticated user with some readable thread fetch another organization's
  // streamed markdown by id. Both bindings are part of the lookup, and a
  // mismatch is indistinguishable from an absent session.
  prisma.runDocumentSession.findFirst({
    where: {
      id: input.sessionId,
      organizationId: input.organizationId,
      threadId: input.threadId,
    },
    select: SESSION_SELECT,
  })

/**
 * Bootstrap watermark for one session.
 *
 * `offset` — the length of the durable markdown in UTF-16 code units, the unit
 * `stream.document.delta` offsets use — is the authoritative merge point: the
 * client drops buffered deltas that end at or below it and applies the
 * straddling tail. `lastSeq` is advisory only and always 0 here: delta sequence
 * numbers are assigned at publish time on the live lane and the durable chunk
 * rows carry no record of them, so the durable lane cannot honestly report one.
 */
export const getThreadDocumentStream = async (
  prisma: PrismaClient,
  input: { organizationId: string; sessionId: string; threadId: string; userId: string },
): Promise<DocumentStreamDetailResponse | null> => {
  const session = await findSession(prisma, input)
  if (!session) {
    return null
  }
  const readable = await canUserReadRunBasis(prisma, {
    organizationId: input.organizationId,
    runId: session.runId,
    userId: input.userId,
  })
  if (!readable) {
    return null
  }

  const chunks = await prisma.runDocumentChunk.findMany({
    where: { sessionId: session.id },
    orderBy: { id: 'asc' },
    select: { content: true },
  })
  const markdown = chunks.map((chunk) => chunk.content).join('')
  const names = await resolveTargetNames(prisma, input.organizationId, [session])

  return {
    lastSeq: 0,
    markdown,
    offset: markdown.length,
    session: toSummary(session, names),
  }
}

const reloadSummary = async (
  prisma: PrismaClient,
  input: { organizationId: string; sessionId: string; threadId: string },
): Promise<DocumentStreamSummary | null> => {
  const row = await findSession(prisma, input)
  if (!row) {
    return null
  }
  const names = await resolveTargetNames(prisma, input.organizationId, [row])
  return toSummary(row, names)
}

const persistOverride = async (
  prisma: PrismaClient,
  sessionId: string,
  target: { parentPageId: string | null; spaceId: string },
): Promise<void> => {
  await prisma.runDocumentSession.update({
    where: { id: sessionId },
    data: {
      overrideParentPageId: target.parentPageId,
      overrideSpaceId: target.spaceId,
    },
  })
}

/**
 * The popup's address bar: send the document somewhere else.
 *
 * One behaviour from the user's seat, two mechanisms. While the document is
 * still being written the new location is persisted on the session and wins over
 * the model's arguments at save time; once it is saved the page itself moves
 * through the same provider core `POST /api/knowledge-base/pages/:pageId/move`
 * calls. Authorization is `canWriteSpace` against the target — the same check
 * the save will make, so a retarget fails at click time rather than at save
 * time.
 */
export const retargetDocumentStream = async (
  prisma: PrismaClient,
  ctx: DocumentStreamActionContext,
  input: {
    organizationId: string
    parentPageId?: string | null
    sessionId: string
    spaceId: string
    threadId: string
  },
): Promise<DocumentStreamRetargetOutcome> => {
  const session = await findSession(prisma, input)
  if (!session) {
    return { kind: 'not_found' }
  }

  const space = await ctx.knowledge.provider.getSpace(input.organizationId, input.spaceId)
  if (!space) {
    return { kind: 'space_not_found' }
  }

  const viewer = await ctx.knowledge.buildViewer(ctx.actorContext)
  if (!canWriteSpace(space, viewer)) {
    return { kind: 'space_forbidden' }
  }

  const parentPageId = input.parentPageId ?? null
  let parentTitle: string | null = null
  if (parentPageId) {
    const parent = await ctx.knowledge.provider.getPage(input.organizationId, parentPageId)
    if (!parent || parent.spaceId !== space.id) {
      return { kind: 'parent_not_found' }
    }
    parentTitle = parent.title
  }

  if (session.status === 'saved') {
    if (!session.pageId) {
      return { kind: 'page_missing' }
    }
    const page = await ctx.knowledge.provider.getPage(input.organizationId, session.pageId)
    if (!page) {
      return { kind: 'page_missing' }
    }
    // The knowledge provider's move core reparents within a space; it has no
    // cross-space form, so a saved document cannot follow a space change.
    if (page.spaceId !== space.id) {
      return { kind: 'cross_space_move' }
    }
    const moved = await ctx.knowledge.provider.movePage({
      organizationId: input.organizationId,
      pageId: page.id,
      parentPageId,
      position: 0,
    })
    if (!moved) {
      return { kind: 'page_missing' }
    }
    await persistOverride(prisma, session.id, { parentPageId, spaceId: space.id })
    const summary = await reloadSummary(prisma, input)
    return summary ? { kind: 'ok', moved: true, session: summary } : { kind: 'not_found' }
  }

  if (session.status !== 'streaming' && session.status !== 'saving') {
    return { kind: 'wrong_status', status: session.status }
  }

  await persistOverride(prisma, session.id, { parentPageId, spaceId: space.id })
  const summary = await reloadSummary(prisma, input)
  if (!summary) {
    return { kind: 'not_found' }
  }

  // Durable publish: a second client watching the same document (phone beside
  // desktop) must learn the new target even if it reconnects across the event.
  const targetEvent: StreamDocumentTargetEvent = {
    runId: parseRunId(session.runId),
    sessionId: session.id,
    spaceId: space.id,
    ...(space.name ? { spaceName: space.name } : {}),
    ...(parentPageId ? { parentPageId } : {}),
    ...(parentTitle ? { parentTitle } : {}),
  }
  await ctx.publishSse(session.threadId, 'stream.document.target', targetEvent)

  return { kind: 'ok', moved: false, session: summary }
}

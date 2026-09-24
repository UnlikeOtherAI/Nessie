import { Prisma, type PrismaClient } from '@prisma/client'
import { canReadSpace, createNativeKnowledgeProvider, loadSpaceViewer } from '@nessie/knowledge'
import {
  DocumentTriggerDeliveryPayloadSchema,
  documentTriggerDeliveryKeyPrefix,
  type DocumentChangedStoredConfig,
  type DocumentTriggerAuthorKind,
  type DocumentTriggerDeliveryPayload,
  type DocumentTriggerFireOn,
  type DocumentTriggerKind,
  type DocumentTriggerScopeFacts,
} from '@nessie/schemas'
import { canMemberEditProjectBoards } from '@nessie/team-admin'

import type { DocumentChangeFacts } from './document-trigger-kickoff.js'

/**
 * What one document trigger's quiet window found, read afresh when it fires
 * (docs/standards/document-triggers.md → "Coalescing"): the page as it is
 * now, the version the agent is brought up to, the marker it starts from, and
 * who saved what lies between. Nothing here reads a word of the document.
 */

const PAGE_SELECT = {
  id: true,
  title: true,
  kind: true,
  spaceId: true,
  projectId: true,
  taskId: true,
  deletedAt: true,
  status: true,
  publishedVersionId: true,
  visibility: true,
  sensitivityTier: true,
  privateToAgentId: true,
  labels: { select: { name: true } },
  space: {
    select: {
      id: true, name: true, projectId: true, visibility: true, sensitivityTier: true,
      privateToAgentId: true, ownerAgentId: true, deletedAt: true,
    },
  },
} satisfies Prisma.KnowledgePageSelect

export type WatchedPage = Prisma.KnowledgePageGetPayload<{ select: typeof PAGE_SELECT }>

export const loadWatchedPage = (prisma: PrismaClient, organizationId: string, pageId: string) =>
  prisma.knowledgePage.findFirst({ where: { id: pageId, organizationId }, select: PAGE_SELECT })

type VersionRow = { id: string; versionNumber: number; authorType: string; authorId: string; createdAt: Date }

/** The version a window brings the agent up to: the newest saved one, or the page's published one. */
export const loadTargetVersion = async (
  prisma: PrismaClient,
  page: Pick<WatchedPage, 'id' | 'publishedVersionId'>,
  fireOn: DocumentTriggerFireOn,
) => {
  const select = {
    id: true,
    versionNumber: true,
    createdAt: true,
    body: true,
    _count: { select: { basisScopes: true, disclosureSources: true } },
  } as const
  if (fireOn === 'publish') {
    return page.publishedVersionId
      ? prisma.knowledgePageVersion.findFirst({ where: { id: page.publishedVersionId, pageId: page.id }, select })
      : null
  }
  return prisma.knowledgePageVersion.findFirst({ where: { pageId: page.id }, orderBy: { versionNumber: 'desc' }, select })
}

/**
 * The marker: the newest version a delivery of this trigger already brought
 * the agent up to for this page. Only a delivered wake, or a window of the
 * agent's own saves, moves it — a skip for lost access or a stopped ticket
 * leaves the change owed, so the next wake's diff still covers it.
 */
export const loadMarker = async (
  prisma: PrismaClient,
  triggerId: string,
  pageId: string,
): Promise<{ id: string; number: number } | null> => {
  const rows = await prisma.agentTriggerDelivery.findMany({
    where: {
      triggerId,
      dedupeKey: { startsWith: documentTriggerDeliveryKeyPrefix(triggerId, pageId) },
      OR: [{ status: 'delivered' }, { status: 'skipped', errorMessage: 'agent_edits_only' }],
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { payload: true },
  })
  let marker: { id: string; number: number } | null = null
  for (const row of rows) {
    const parsed = DocumentTriggerDeliveryPayloadSchema.safeParse(row.payload)
    if (!parsed.success) continue
    if (!marker || parsed.data.toVersionNumber > marker.number) {
      marker = { id: parsed.data.toVersionId, number: parsed.data.toVersionNumber }
    }
  }
  return marker
}

/**
 * Where the first wake of a page starts when no delivery set a marker yet:
 * the page as it stood when the trigger was set up — its newest version saved
 * before then — so the first review is a diff of what changed since, not the
 * whole document. Null for a page created after the trigger.
 */
export const loadBaseline = async (
  prisma: PrismaClient,
  pageId: string,
  triggerCreatedAt: Date,
): Promise<{ id: string; number: number } | null> => {
  const version = await prisma.knowledgePageVersion.findFirst({
    where: { pageId, createdAt: { lt: triggerCreatedAt } },
    orderBy: { versionNumber: 'desc' },
    select: { id: true, versionNumber: true },
  })
  return version ? { id: version.id, number: version.versionNumber } : null
}

/** The page's folders, nearest first — a folder trigger watches its subtree. */
const ancestorIds = async (prisma: PrismaClient, pageId: string): Promise<string[]> => {
  const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    WITH RECURSIVE chain AS (
      SELECT parent_page_id AS id, 1 AS depth FROM knowledge_pages WHERE id = ${pageId}::uuid
      UNION ALL
      SELECT p.parent_page_id, chain.depth + 1 FROM knowledge_pages p JOIN chain ON p.id = chain.id WHERE chain.depth < 64
    )
    SELECT id::text AS id FROM chain WHERE id IS NOT NULL ORDER BY depth
  `)
  return rows.map((row) => row.id)
}

export const scopeFactsOf = async (prisma: PrismaClient, page: WatchedPage): Promise<DocumentTriggerScopeFacts> => ({
  spaceId: page.spaceId,
  kind: page.kind,
  pageId: page.id,
  ancestorIds: await ancestorIds(prisma, page.id),
  labels: page.labels.map((label) => label.name),
})

/**
 * Whether the agent can still read the page, as `kb_page_read` would decide:
 * the space by the agent's own reach, and no page-level narrowing an agent
 * never passes (restricted, or private to another agent).
 */
export const agentCanReadPage = async (
  prisma: PrismaClient,
  input: { organizationId: string; agentId: string; page: WatchedPage },
): Promise<boolean> => {
  if (input.page.sensitivityTier === 'restricted') return false
  if (input.page.privateToAgentId && input.page.privateToAgentId !== input.agentId) return false
  const space = await createNativeKnowledgeProvider(prisma).getSpace(input.organizationId, input.page.spaceId)
  if (!space) return false
  const viewer = await loadSpaceViewer(prisma, input.organizationId, { actorType: 'agent', actorId: input.agentId })
  return canReadSpace(space, viewer)
}

const CHANNEL_WIDE = new Set(['project', 'organization'])

/**
 * Whether every reader of the target channel may read the page, so its title
 * may be said there. The space already is (checked on every fire); the page
 * must not be narrower, and the version must carry no disclosure basis of its
 * own — a version written from a private conversation is not the channel's.
 */
export const pageNameableInChannel = (
  page: WatchedPage,
  version: { _count: { basisScopes: number; disclosureSources: number } },
): boolean =>
  CHANNEL_WIDE.has(page.visibility)
  && page.privateToAgentId === null
  && page.sensitivityTier !== 'restricted'
  && version._count.basisScopes === 0
  && version._count.disclosureSources === 0

export type CountedVersions = {
  versions: VersionRow[]
  counted: VersionRow[]
  /** People among the counted authors who can edit the page's project's boards. */
  editorCount: number
}

/**
 * The versions after the marker, up to the target, and those that wake the
 * agent: its own never do, so it cannot loop on its own edits; another
 * agent's only with `includeAgentEdits`, and never an agent that reviews this
 * project's documents itself, so two reviewers cannot wake each other.
 */
export const countVersions = async (
  prisma: PrismaClient,
  input: {
    organizationId: string
    projectId: string
    agentId: string
    config: Pick<DocumentChangedStoredConfig, 'includeAgentEdits'>
    pageId: string
    fromNumber: number
    toNumber: number
  },
): Promise<CountedVersions> => {
  const versions = await prisma.knowledgePageVersion.findMany({
    where: { pageId: input.pageId, versionNumber: { gt: input.fromNumber, lte: input.toNumber } },
    orderBy: { versionNumber: 'asc' },
    select: { id: true, versionNumber: true, authorType: true, authorId: true, createdAt: true },
  })
  // Two agents that review each other's saves would wake each other forever,
  // so an agent that itself reviews this project's documents never counts.
  const otherAgents = [...new Set(versions
    .filter((version) => version.authorType === 'agent' && version.authorId !== input.agentId)
    .map((version) => version.authorId))]
  const reviewers = input.config.includeAgentEdits && otherAgents.length > 0
    ? new Set((await prisma.agentTrigger.findMany({
        where: {
          agentId: { in: otherAgents },
          type: 'document_changed',
          enabled: true,
          scopeProjectId: input.projectId,
        },
        select: { agentId: true },
      })).map((trigger) => trigger.agentId))
    : new Set<string | null>()
  const counted = versions.filter((version) =>
    version.authorType !== 'agent'
    || (version.authorId !== input.agentId && input.config.includeAgentEdits && !reviewers.has(version.authorId)))
  const people = [...new Set(counted.filter((version) => version.authorType !== 'agent').map((version) => version.authorId))]
  const editors = await Promise.all(people.map((userId) => canMemberEditProjectBoards(prisma, {
    organizationId: input.organizationId,
    userId,
    projectId: input.projectId,
  })))
  return { versions, counted, editorCount: editors.filter(Boolean).length }
}

export const authorKindsOf = (counted: readonly VersionRow[]): DocumentTriggerAuthorKind[] => [
  ...(counted.some((version) => version.authorType !== 'agent') ? ['person' as const] : []),
  ...(counted.some((version) => version.authorType === 'agent') ? ['agent' as const] : []),
]

/** The payload every delivery of this window carries, whatever was decided. */
export const deliveryBaseOf = (input: {
  page: WatchedPage
  fireOn: DocumentTriggerFireOn
  from: { id: string; number: number } | null
  to: { id: string; versionNumber: number; body: string | null }
  versionsCoalesced: number
}): Omit<DocumentTriggerDeliveryPayload, 'outcome' | 'skipReason' | 'workId' | 'threadId' | 'authorKinds'> => ({
  pageId: input.page.id,
  spaceId: input.page.spaceId,
  projectId: input.page.projectId,
  taskId: input.page.taskId,
  kind: (input.page.kind === 'file' ? 'file' : 'document') satisfies DocumentTriggerKind,
  fireOn: input.fireOn,
  fromVersionId: input.from?.id ?? null,
  fromVersionNumber: input.from?.number ?? null,
  toVersionId: input.to.id,
  toVersionNumber: input.to.versionNumber,
  versionsCoalesced: input.versionsCoalesced,
  bodyChars: input.to.body?.length ?? 0,
})

/** The change as its kickoff tells it. */
export const changeFactsOf = (input: {
  page: WatchedPage
  nameable: boolean
  fireOn: DocumentTriggerFireOn
  from: { id: string; number: number } | null
  to: { id: string; versionNumber: number; body: string | null }
  counts: CountedVersions
}): DocumentChangeFacts => {
  const people = input.counts.counted.filter((version) => version.authorType !== 'agent')
  const agents = input.counts.counted.filter((version) => version.authorType === 'agent')
  const distinctPeople = new Set(people.map((version) => version.authorId)).size
  return {
    page: {
      id: input.page.id,
      title: input.page.title,
      kind: input.page.kind,
      spaceId: input.page.spaceId,
      spaceName: input.page.space.name,
    },
    nameable: input.nameable,
    fireOn: input.fireOn,
    from: input.from,
    to: { id: input.to.id, number: input.to.versionNumber },
    versionsCoalesced: input.counts.versions.length,
    counted: { people: distinctPeople, agents: new Set(agents.map((version) => version.authorId)).size },
    authorKinds: authorKindsOf(input.counts.counted),
    untrusted: agents.length > 0 || input.counts.editorCount < distinctPeople,
    bodyChars: input.to.body?.length ?? 0,
  }
}

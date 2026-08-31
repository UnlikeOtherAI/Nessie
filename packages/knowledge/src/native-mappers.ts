import { Prisma } from '@prisma/client'
import type {
  KnowledgePageRecord,
  KnowledgePageVersionRecord,
  KnowledgeSpaceRecord,
} from './types.js'

export const pageInclude = {
  labels: { orderBy: { normalizedName: 'asc' as const } },
  publishedVersion: true,
  versions: { orderBy: { versionNumber: 'desc' as const }, take: 1 },
} satisfies Prisma.KnowledgePageInclude

export type PageRow = Prisma.KnowledgePageGetPayload<{ include: typeof pageInclude }>

export const spaceInclude = {
  members: { select: { userId: true, agentId: true } },
} satisfies Prisma.KnowledgeSpaceInclude

// Prisma includes scalar fields such as `ownerAgentId` alongside relation
// includes, so the shared row shape carries ownership without loading the
// Agent relation or creating another visibility lookup here.
export type SpaceRow = Prisma.KnowledgeSpaceGetPayload<{ include: typeof spaceInclude }>

const toJsonRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const toIso = (value: Date | null): string | null => value?.toISOString() ?? null

export const mapVersion = (
  version: Prisma.KnowledgePageVersionGetPayload<Record<string, never>> | null,
): KnowledgePageVersionRecord | null =>
  version
    ? {
        id: version.id,
        pageId: version.pageId,
        versionNumber: version.versionNumber,
        body: version.body,
        bodyRef: version.bodyRef,
        attachmentId: version.attachmentId,
        authorType: version.authorType,
        authorId: version.authorId,
        changeComment: version.changeComment,
        createdAt: version.createdAt.toISOString(),
      }
    : null

export const mapSpace = (space: SpaceRow): KnowledgeSpaceRecord => ({
  id: space.id,
  name: space.name,
  description: space.description,
  metadata: toJsonRecord(space.metadata),
  ownerAgentId: space.ownerAgentId,
  writeRestricted: space.writeRestricted,
  memberUserIds: space.members
    .map((member) => member.userId)
    .filter((id): id is string => id !== null),
  memberAgentIds: space.members
    .map((member) => member.agentId)
    .filter((id): id is string => id !== null),
  organizationId: space.organizationId,
  projectId: space.projectId,
  teamId: space.teamId,
  channelId: space.channelId,
  threadId: space.threadId,
  userId: space.userId,
  visibility: space.visibility,
  sensitivityTier: space.sensitivityTier,
  privateToAgentId: space.privateToAgentId,
  createdBy: space.createdBy,
  deletedAt: toIso(space.deletedAt),
  createdAt: space.createdAt.toISOString(),
  updatedAt: space.updatedAt.toISOString(),
})

export const mapPage = (page: PageRow): KnowledgePageRecord => ({
  id: page.id,
  spaceId: page.spaceId,
  title: page.title,
  summary: page.summary,
  metadata: toJsonRecord(page.metadata),
  kind: page.kind,
  parentPageId: page.parentPageId,
  position: page.position,
  status: page.status,
  taskId: page.taskId,
  labels: page.labels.map((label) => label.name),
  latestVersion: mapVersion(page.versions[0] ?? null),
  publishedVersion: mapVersion(page.publishedVersion),
  publishedVersionId: page.publishedVersionId,
  organizationId: page.organizationId,
  projectId: page.projectId,
  teamId: page.teamId,
  channelId: page.channelId,
  threadId: page.threadId,
  userId: page.userId,
  visibility: page.visibility,
  sensitivityTier: page.sensitivityTier,
  privateToAgentId: page.privateToAgentId,
  createdBy: page.createdBy,
  deletedAt: toIso(page.deletedAt),
  createdAt: page.createdAt.toISOString(),
  updatedAt: page.updatedAt.toISOString(),
})

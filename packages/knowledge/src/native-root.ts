import type { PrismaClient } from '@prisma/client'
import type { KnowledgeRoot, KnowledgeRootSpace } from '@nessie/schemas'

import { canWriteSpace, type SpaceViewer } from './access.js'
import { ensureMyDocsSpace, ensureProjectDocumentsSpace } from './provisioning.js'
import type { KnowledgeProvider, KnowledgeSpaceRecord } from './types.js'

/**
 * The Finder's root column in one read: My Documents, one row per project the
 * viewer can reach, the readable folders that are neither, and the badge count
 * for "Shared with me".
 *
 * Assembling this on the client would be three round trips (`GET /spaces`,
 * `POST /my-docs`, `GET /projects`) and would put a paged list under a tree that
 * must not page.
 *
 * The project set is the caller's accessible-project read — the same
 * entitlement `GET /api/projects` is scoped by — so a project an organisation
 * owner/admin reaches without a membership is a row here too; listing it in
 * one surface and not the other is the drift that hid an owner's own project.
 * Every listed project's Documents space is provisioned by the read itself
 * (idempotent and advisory-locked, in bounded batches): a project row that
 * opens onto nothing is a doorway to a client-side provisioning hack, which is
 * what the nullable `space` and the `project-unopened` row used to be.
 *
 * Contract: docs/plans/2026-09-16-documents-finder-ui/data-and-api.md §7.
 */

/** More than this many readable shared folders and the status bar says so. */
export const ROOT_SHARED_SPACE_CAP = 200

/**
 * Project provisioning fans out one advisory-locked transaction per project;
 * an unbounded Promise.all would hand the pool a transaction per project at
 * once, so the ensures run in batches of this many.
 */
const ROOT_PROVISION_BATCH = 8

const mapInBatches = async <TItem, TResult>(
  items: TItem[],
  batchSize: number,
  map: (item: TItem) => Promise<TResult>,
): Promise<TResult[]> => {
  const results: TResult[] = []
  for (let index = 0; index < items.length; index += batchSize) {
    results.push(...await Promise.all(items.slice(index, index + batchSize).map(map)))
  }
  return results
}

export type BuildKnowledgeRootInput = {
  /**
   * The projects the caller may reach: `'all'` for an organisation
   * owner/admin (no project filter at all), otherwise their membership ids —
   * `listAccessibleProjectIds`'s answer, resolved by the route because the
   * entitlement needs the actor context the route holds.
   */
  accessibleProjectIds: string[] | 'all'
  organizationId: string
  // Where My Documents is filed when it has to be provisioned. Same source the
  // existing POST /my-docs uses: the caller's active project.
  projectId: string
  userId: string
  viewer: SpaceViewer
  provider: KnowledgeProvider
  /** `canManageKnowledgeSpaceAccess` — it needs the actor context the route holds. */
  canManageAccess: (space: KnowledgeSpaceRecord) => boolean
}

export type BuildKnowledgeRootResult = {
  root: KnowledgeRoot
  /** True only when this call provisioned My Documents — the audit event's gate. */
  myDocumentsCreated: boolean
}

const isFlagged = (metadata: unknown, flag: string): boolean =>
  typeof metadata === 'object'
  && metadata !== null
  && !Array.isArray(metadata)
  && (metadata as Record<string, unknown>)[flag] === true

const byName = (left: { name: string }, right: { name: string }): number =>
  left.name.localeCompare(right.name)

export const buildKnowledgeRoot = async (
  prisma: PrismaClient,
  input: BuildKnowledgeRootInput,
): Promise<BuildKnowledgeRootResult> => {
  const { provider, viewer } = input
  const toRootSpace = (space: KnowledgeSpaceRecord, projectName: string | null): KnowledgeRootSpace => ({
    spaceId: space.id,
    name: space.name,
    canWrite: canWriteSpace(space, viewer),
    canManageAccess: input.canManageAccess(space),
    visibility: space.visibility ?? 'private',
    writeRestricted: space.writeRestricted,
    ownerAgentId: space.ownerAgentId,
    projectId: space.projectId,
    projectName,
    updatedAt: space.updatedAt,
  })

  // My Documents is provisioned on first open by the same ensure call POST
  // /my-docs makes, so the root never shows a folder that is not there yet.
  const myDocs = await ensureMyDocsSpace(prisma, {
    organizationId: input.organizationId,
    projectId: input.projectId,
    userId: input.userId,
  })
  const myDocsSpace = await provider.getSpace(input.organizationId, myDocs.spaceId)
  if (!myDocsSpace) throw new Error('My Documents space could not be loaded after provisioning')

  const accessible = input.accessibleProjectIds
  const [projects, agentPage, sharedPage, sharedWithMeCount] = await Promise.all([
    accessible !== 'all' && accessible.length === 0 ? [] : prisma.project.findMany({
      where: {
        organizationId: input.organizationId,
        // The same filters listProjectsForUser carries: a channel-root anchor
        // project is not a Documents folder a person opens, and a deleted
        // project is gone for everybody.
        channelRoot: false,
        deletedAt: null,
        ...(accessible === 'all' ? {} : { id: { in: accessible } }),
      },
      select: { id: true, name: true },
    }),
    // Personal spaces are excluded by the same flag GET /spaces uses; the
    // viewer's own is already above, and nobody else's is readable at space
    // level (a share reaches the page, not the folder).
    provider.listSpaces({
      agentOwnedOnly: true,
      includePersonal: true,
      organizationId: input.organizationId,
      limit: ROOT_SHARED_SPACE_CAP,
      viewer,
    }),
    provider.listSpaces({
      excludeAgentOwned: true,
      organizationId: input.organizationId,
      limit: ROOT_SHARED_SPACE_CAP,
      viewer,
    }),
    prisma.knowledgePageShare.count({
      where: { organizationId: input.organizationId, granteeUserId: input.userId },
    }),
  ])

  // Every listed project gets its Documents folder here rather than on first
  // open: ensureProjectDocumentsSpace is idempotent and advisory-locked, so a
  // repeat read finds the row and two concurrent reads cannot double-create.
  const ensured = await mapInBatches(
    projects,
    ROOT_PROVISION_BATCH,
    async (project) => ({
      projectId: project.id,
      spaceId: (await ensureProjectDocumentsSpace(prisma, {
        actorId: input.userId,
        organizationId: input.organizationId,
        projectId: project.id,
      })).spaceId,
    }),
  )
  const projectSpaceIdByProjectId = new Map(
    ensured.map((entry) => [entry.projectId, entry.spaceId]),
  )

  const readableById = new Map(sharedPage.data.map((space) => [space.id, space]))
  const projectNames = new Map(projects.map((project) => [project.id, project.name]))
  // A project's Documents space may exist without being in the capped page, so
  // load the ones that belong to a project row directly.
  const missingProjectSpaceIds = Array.from(projectSpaceIdByProjectId.values()).filter(
    (id) => !readableById.has(id),
  )
  const loadedProjectSpaces = await mapInBatches(
    missingProjectSpaceIds,
    ROOT_PROVISION_BATCH,
    (id) => provider.getSpace(input.organizationId, id),
  )
  for (const space of loadedProjectSpaces) {
    if (space) readableById.set(space.id, space)
  }

  const projectRows = projects
    .map((project) => {
      const spaceId = projectSpaceIdByProjectId.get(project.id)
      const space = spaceId ? readableById.get(spaceId) : undefined
      if (!space) {
        throw new Error(`Project Documents space could not be loaded after provisioning: ${project.id}`)
      }
      return {
        projectId: project.id,
        projectName: project.name,
        space: toRootSpace(space, project.name),
      }
    })
    .sort((left, right) => left.projectName.localeCompare(right.projectName))

  const agentHomes = agentPage.data
    .sort(byName)
    .map((space) => toRootSpace(space, projectNames.get(space.projectId) ?? null))

  // The third group by definition: readable, not personal, not agent-owned,
  // and not a project's Documents folder.
  const shared = sharedPage.data
    .filter((space) => space.id !== myDocsSpace.id)
    .filter((space) => !isFlagged(space.metadata, 'personal'))
    .filter((space) => !isFlagged(space.metadata, 'projectDocuments'))
    .sort(byName)
    .map((space) => toRootSpace(space, projectNames.get(space.projectId) ?? null))

  const sharedProjectIds = Array.from(new Set(
    [...agentHomes, ...shared]
      .filter((space) => space.projectName === null)
      .map((space) => space.projectId),
  ))
  if (sharedProjectIds.length > 0) {
    // A shared folder's subtitle names the project it is filed under, which may
    // be a project the viewer does not belong to.
    const extra = await prisma.project.findMany({
      where: { id: { in: sharedProjectIds }, organizationId: input.organizationId },
      select: { id: true, name: true },
    })
    const extraNames = new Map(extra.map((project) => [project.id, project.name]))
    for (const space of [...agentHomes, ...shared]) {
      if (space.projectName === null) space.projectName = extraNames.get(space.projectId) ?? null
    }
  }

  return {
    myDocumentsCreated: myDocs.created,
    root: {
      agentHomes,
      agentHomesTruncated: agentPage.meta.hasMore,
      myDocuments: toRootSpace(myDocsSpace, projectNames.get(myDocsSpace.projectId) ?? null),
      projects: projectRows,
      shared,
      sharedTruncated: sharedPage.meta.hasMore,
      sharedWithMeCount,
    },
  }
}

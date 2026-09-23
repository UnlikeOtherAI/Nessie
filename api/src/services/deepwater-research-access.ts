import type { PrismaClient } from '@prisma/client'
import {
  isDeepWaterRunVisible,
  readDeepWaterBriefRun,
  resolveDisclosureViewer,
  toDeepWaterBriefView,
  toDeepWaterResearchRunView,
  type DeepWaterBriefRun,
  type DeepWaterOriginDestination,
  type DisclosureViewer,
} from '@nessie/runtime'
import {
  isAdminActor,
  type AuthorizedActionContext,
  type DeepWaterBriefView,
  type DeepWaterResearchRunView,
} from '@nessie/schemas'
import { buildViewerThreadWhere } from '@nessie/team-admin'

/**
 * Who may see which DeepWater research, for the brief API (Water plan
 * nessie.md §7.1, amendments N6). Every read of a run — the list, the detail,
 * the brief, the card and the artifacts — goes through `isDeepWaterRunVisible`
 * with the live viewer and the origin thread's live destination; this module
 * loads those facts, in one batch for a list page, and builds the views.
 */

/** The planner as the brief dialog names it. Nessie's words, never DeepWater's own display. */
const PLANNER = { displayName: 'DeepWater research planner', iconUrl: null }

export type DeepWaterResearchViewer = {
  organizationId: string
  userId: string
  /** The session's team: an owner's authority over research reaches this team's runs only. */
  teamId: string | null
  /**
   * An organisation owner or admin: may cancel any open research in their
   * team, whoever asked for it (N8.5).
   */
  canChangeTeam: boolean
  disclosure: DisclosureViewer
}

export const resolveDeepWaterResearchViewer = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
): Promise<DeepWaterResearchViewer> => {
  const organizationId = actorContext.tenant.organizationId
  const userId = actorContext.actor.actorId
  return {
    organizationId,
    userId,
    teamId: actorContext.tenant.teamId ?? actorContext.actionContext.teamId ?? null,
    canChangeTeam: isAdminActor(actorContext),
    disclosure: await resolveDisclosureViewer(prisma, organizationId, userId, {
      uoaIdentity: actorContext.actionContext.uoaIdentity,
    }),
  }
}

type OriginReach = {
  /** Origin threads the viewer may open (`findThreadForUser`'s predicate). */
  reachable: ReadonlySet<string>
  /** Each live origin thread's destination: its channel chain and bound agents. */
  destinations: ReadonlyMap<string, DeepWaterOriginDestination>
}

/** The origin facts of every run on a page, in three queries however long the page. */
const loadOriginReach = async (
  prisma: PrismaClient,
  viewer: DeepWaterResearchViewer,
  runs: readonly DeepWaterBriefRun[],
): Promise<OriginReach> => {
  const threadIds = [...new Set(runs.map((run) => run.threadId).filter((id): id is string => id !== null))]
  if (threadIds.length === 0) return { reachable: new Set(), destinations: new Map() }
  const [reachable, threads] = await Promise.all([
    prisma.thread.findMany({
      where: { id: { in: threadIds }, ...buildViewerThreadWhere(viewer.userId, viewer.organizationId) },
      select: { id: true },
    }),
    prisma.thread.findMany({
      where: { id: { in: threadIds }, channel: { organizationId: viewer.organizationId, deletedAt: null } },
      select: { id: true, channel: { select: { id: true, organizationId: true, projectId: true, teamId: true } } },
    }),
  ])
  const channelIds = [...new Set(threads.map((thread) => thread.channel.id))]
  const bindings = channelIds.length === 0
    ? []
    : await prisma.agentBinding.findMany({
        where: { channelId: { in: channelIds } },
        select: { agentId: true, channelId: true },
      })
  const destinations = new Map<string, DeepWaterOriginDestination>(threads.map((thread) => [thread.id, {
    chain: {
      organizationId: thread.channel.organizationId,
      projectId: thread.channel.projectId,
      teamId: thread.channel.teamId,
      channelId: thread.channel.id,
    },
    boundAgentIds: bindings
      .filter((binding) => binding.channelId === thread.channel.id)
      .map((binding) => binding.agentId),
  }]))
  return { reachable: new Set(reachable.map((thread) => thread.id)), destinations }
}

const isVisible = (viewer: DeepWaterResearchViewer, reach: OriginReach, run: DeepWaterBriefRun): boolean =>
  isDeepWaterRunVisible({
    run,
    viewerUserId: viewer.userId,
    viewer: viewer.disclosure,
    originThreadReachable: run.threadId !== null && reach.reachable.has(run.threadId),
    originDestination: run.threadId === null ? null : reach.destinations.get(run.threadId) ?? null,
  })

/** The runs of a page this viewer may see, in their order. */
export const filterVisibleDeepWaterRuns = async (
  prisma: PrismaClient,
  viewer: DeepWaterResearchViewer,
  runs: readonly DeepWaterBriefRun[],
): Promise<DeepWaterBriefRun[]> => {
  if (viewer.disclosure.kind === 'denied' || runs.length === 0) return []
  const reach = await loadOriginReach(prisma, viewer, runs)
  return runs.filter((run) => isVisible(viewer, reach, run))
}

/**
 * One run, if this viewer may see it — the check every route and artifact
 * download makes before it reads or acts on a run. Null answers 404, so a run
 * the viewer may not see is indistinguishable from one that does not exist.
 */
export const loadVisibleDeepWaterRun = async (
  prisma: PrismaClient,
  viewer: DeepWaterResearchViewer,
  runId: string,
): Promise<DeepWaterBriefRun | null> => {
  const run = await readDeepWaterBriefRun(prisma, { organizationId: viewer.organizationId, runId })
  if (!run) return null
  const [visible] = await filterVisibleDeepWaterRuns(prisma, viewer, [run])
  return visible ?? null
}

/** The Knowledge space of each delivered report page on a page of runs. */
const loadReportSpaces = async (
  prisma: PrismaClient,
  runs: readonly DeepWaterBriefRun[],
): Promise<Map<string, string>> => {
  const pageIds = runs.map((run) => run.knowledgePageId).filter((id): id is string => id !== null)
  if (pageIds.length === 0) return new Map()
  const pages = await prisma.knowledgePage.findMany({
    where: { id: { in: pageIds } },
    select: { id: true, spaceId: true },
  })
  return new Map(pages.map((page) => [page.id, page.spaceId]))
}

const viewContext = (viewer: DeepWaterResearchViewer, spaces: Map<string, string>, run: DeepWaterBriefRun) => ({
  viewer: { userId: viewer.userId, canChangeTeam: viewer.canChangeTeam && viewer.teamId === run.teamId },
  reportSpaceId: run.knowledgePageId === null ? null : spaces.get(run.knowledgePageId) ?? null,
})

/** Research views of runs the caller has already checked are visible. */
export const toDeepWaterResearchRunViews = async (
  prisma: PrismaClient,
  viewer: DeepWaterResearchViewer,
  runs: readonly DeepWaterBriefRun[],
): Promise<DeepWaterResearchRunView[]> => {
  const spaces = await loadReportSpaces(prisma, runs)
  return runs.map((run) => toDeepWaterResearchRunView(run, viewContext(viewer, spaces, run)))
}

/** The brief view of a run the caller has already checked is visible. */
export const toDeepWaterBriefViewFor = async (
  prisma: PrismaClient,
  viewer: DeepWaterResearchViewer,
  run: DeepWaterBriefRun,
): Promise<DeepWaterBriefView> => {
  const spaces = await loadReportSpaces(prisma, [run])
  return toDeepWaterBriefView(run, { ...viewContext(viewer, spaces, run), planner: PLANNER })
}

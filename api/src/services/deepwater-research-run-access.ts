import type { PrismaClient } from '@prisma/client'
import {
  isDeepWaterRunVisible,
  loadDeepWaterOriginDestination,
  readDeepWaterBriefRun,
  resolveDisclosureViewer,
  resolveLiveEntitlements,
  type DeepWaterBriefRun,
} from '@nessie/runtime'
import type { UoaSessionIdentity } from '@nessie/schemas'

import { findThreadForUser } from './message-read-state.js'

/**
 * The one door a person's read of a DeepWater research takes in the API
 * (Water plan amendments N6): load the run, resolve the viewer from a fresh
 * UOA decision, and ask `isDeepWaterRunVisible` — the predicate the list,
 * detail, brief, card, artifact downloads and Copy markdown all share. A run
 * the viewer may not see answers exactly like a run that does not exist, so a
 * research id never confirms that research to someone outside it.
 */

export type DeepWaterRunAccessDeps = {
  prisma: PrismaClient
  /** Test seam for the live UOA membership read, as the knowledge routes have. */
  resolveLiveEntitlements?: typeof resolveLiveEntitlements
}

export type DeepWaterRunViewerInput = {
  organizationId: string
  userId: string
  /** The request's own UOA identity, when the session carries one. */
  uoaIdentity?: UoaSessionIdentity | undefined
  runId: string
}

/** The run, when this person may see it; otherwise null. */
export const loadVisibleDeepWaterRun = async (
  deps: DeepWaterRunAccessDeps,
  input: DeepWaterRunViewerInput,
): Promise<DeepWaterBriefRun | null> => {
  const { prisma } = deps
  const run = await readDeepWaterBriefRun(prisma, { organizationId: input.organizationId, runId: input.runId })
  if (!run) return null

  // One live decision serves both the viewer's scopes and nothing else here;
  // an unavailable UOA answer is a denial, never a cached allow.
  const liveEntitlements = await (deps.resolveLiveEntitlements ?? resolveLiveEntitlements)(prisma, {
    organizationId: input.organizationId,
    userId: input.userId,
    uoaIdentity: input.uoaIdentity,
  })
  const viewer = await resolveDisclosureViewer(prisma, input.organizationId, input.userId, { liveEntitlements })
  const [originThread, originDestination] = await Promise.all([
    run.threadId === null
      ? Promise.resolve(null)
      : findThreadForUser(prisma, run.threadId, input.userId, input.organizationId),
    loadDeepWaterOriginDestination(prisma, { organizationId: input.organizationId, threadId: run.threadId }),
  ])
  const visible = isDeepWaterRunVisible({
    run,
    viewerUserId: input.userId,
    viewer,
    originThreadReachable: originThread !== null,
    originDestination,
  })
  return visible ? run : null
}

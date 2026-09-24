import type { PrismaClient } from '@prisma/client'
import type {
  AuthorizedActionContext,
  ExecutorLocalMcpReport,
  ExecutorProfile,
  ExecutorStatus,
} from '@nessie/schemas'

import { getExecutorAccessView, listVisibleExecutors } from './executor-records.js'
import { offersReviewedCodingSessions } from './executor-standing-policy-machines.js'

/**
 * One executor as a design-time fact: everything a specialist agent needs to
 * say which machine it is talking about and what could be granted on it, and
 * nothing a reviewer of that executor has not already been shown.
 *
 * `canManage` is load-bearing rather than decorative. The capability revision
 * and the local MCP report are administrator-only reads — `executor_inspect`
 * withholds both from somebody who may merely *use* an executor — so a person
 * without that standing gets them as **unreadable**, never as absent. Absent
 * already means "this daemon has never reported", and collapsing "you may not
 * read it" into that would have the catalogue state a fact about somebody
 * else's machine that nobody established.
 */
export type GlobalAgentExecutorFacts = {
  /** True when this person may administer it, and so could grant it at all. */
  canManage: boolean
  /**
   * Its active reviewed revision offers the local-apps pair and the
   * coding-sessions bridge. False too when this person cannot read its
   * policy (`canManage` false): nothing established that it does.
   */
  codingSessionsReviewed: boolean
  executorId: string
  label: string
  lastSeenAt?: string
  /**
   * Present only when the person may administer the executor AND the daemon
   * has reported at least once. An empty array is a daemon that reports and
   * names no server — a different fact from either absence.
   */
  localMcp?: ExecutorLocalMcpReport
  localMcpObservedAt?: string
  /**
   * The operation keys the **active** capability revision names. Absent means
   * either that no revision has been activated on this executor yet or that
   * the person cannot read its policy at all; `canManage` tells the two apart.
   */
  operationKeys?: string[]
  /**
   * A private machine this person paired. With `codingSessionsReviewed` it is
   * one a standing policy of theirs can put a trigger's ticket work on, since
   * a coding session acts as whoever paired the machine.
   */
  pairedByYou: boolean
  profiles: ExecutorProfile[]
  projectId?: string
  revision?: number
  scopeKind: 'private' | 'project' | 'organization'
  status: ExecutorStatus
  statusDetail?: string
}

/**
 * Every executor the requesting person is entitled to see, with the detail
 * their own access already affords them.
 *
 * Visibility is `listVisibleExecutors`' and no wider: organization scope,
 * project scope they belong to or manage, private scope they are assigned.
 * An agent reading this acts as that person with exactly their authority, so
 * "all executors" means all of *theirs*.
 *
 * **The detail reads are batched, not fanned out.** This runs on every
 * designer turn, and `getExecutorAccessView` is around nine queries per
 * executor. Firing one per executor concurrently put a whole estate's worth of
 * connections in flight for a single message, on a pool the rest of the
 * deployment shares. Every executor still gets its full detail; they are
 * simply resolved a few at a time.
 */
const DETAIL_BATCH = 4

export const listExecutorCatalogueFacts = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
): Promise<GlobalAgentExecutorFacts[]> => {
  const executors = await listVisibleExecutors(prisma, actorContext)
  const owned = new Set((await prisma.executor.findMany({
    where: {
      id: { in: executors.map((executor) => executor.id) },
      pairingOwnerUserId: actorContext.actor.actorId,
      scopeKind: 'private',
    },
    select: { id: true },
  })).map((executor) => executor.id))
  const facts: GlobalAgentExecutorFacts[] = []
  for (let index = 0; index < executors.length; index += DETAIL_BATCH) {
    const batch = await Promise.all(
      executors.slice(index, index + DETAIL_BATCH).map(detailFor(prisma, actorContext, owned)),
    )
    facts.push(...batch)
  }
  return facts
}

const detailFor = (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  owned: ReadonlySet<string>,
) =>
  async (executor: Awaited<ReturnType<typeof listVisibleExecutors>>[number],
  ): Promise<GlobalAgentExecutorFacts> => {
    // The same entitlement-scoped read `executor_inspect` makes, rather than a
    // second query shaped for this caller: it is what withholds an
    // administrator-only field from somebody who may only use the machine.
    const access = await getExecutorAccessView(prisma, actorContext, executor.id)
    const canManage = access?.canManage === true
    // The LATEST revision, and only when it is active — the same definition
    // `executor-binding.ts` and `executor-commands.ts` enforce. Reviewing a
    // revision never demotes the one before it, so picking "the highest-
    // numbered active revision" would name a superseded policy as live: the
    // Designer would tell somebody an executor offers operations the daemon
    // will refuse, immediately before they authorise a grant over them.
    const latest = canManage
      ? [...(access?.descriptorRevisions ?? [])]
        .sort((left, right) => right.revision - left.revision)[0]
      : undefined
    const active = latest?.reviewStatus === 'active' ? latest : undefined
    return {
      canManage,
      codingSessionsReviewed: active !== undefined && offersReviewedCodingSessions(active),
      executorId: executor.id,
      label: executor.label,
      ...(executor.lastSeenAt ? { lastSeenAt: executor.lastSeenAt } : {}),
      ...(canManage && access?.localMcp !== undefined ? { localMcp: access.localMcp } : {}),
      ...(canManage && access?.localMcpObservedAt !== undefined
        ? { localMcpObservedAt: access.localMcpObservedAt }
        : {}),
      ...(active ? { operationKeys: active.operationKeys, revision: active.revision } : {}),
      pairedByYou: owned.has(executor.id),
      profiles: executor.profiles,
      ...(executor.scope.kind === 'project' ? { projectId: executor.scope.projectId } : {}),
      scopeKind: executor.scope.kind,
      status: executor.status,
      ...(executor.statusDetail ? { statusDetail: executor.statusDetail } : {}),
    }
  }

import type { PrismaClient } from '@prisma/client'
import type {
  AuthorizedActionContext,
  ExecutorLocalMcpReport,
  ExecutorProfile,
  ExecutorStatus,
} from '@nessie/schemas'

import { getExecutorAccessView, listVisibleExecutors } from './executor-records.js'

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
 */
export const listExecutorCatalogueFacts = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
): Promise<GlobalAgentExecutorFacts[]> => {
  const executors = await listVisibleExecutors(prisma, actorContext)
  return Promise.all(executors.map(async (executor): Promise<GlobalAgentExecutorFacts> => {
    // The same entitlement-scoped read `executor_inspect` makes, rather than a
    // second query shaped for this caller: it is what withholds an
    // administrator-only field from somebody who may only use the machine.
    const access = await getExecutorAccessView(prisma, actorContext, executor.id)
    const canManage = access?.canManage === true
    const active = canManage
      ? (access?.descriptorRevisions ?? []).find((revision) => revision.reviewStatus === 'active')
      : undefined
    return {
      canManage,
      executorId: executor.id,
      label: executor.label,
      ...(executor.lastSeenAt ? { lastSeenAt: executor.lastSeenAt } : {}),
      ...(canManage && access?.localMcp !== undefined ? { localMcp: access.localMcp } : {}),
      ...(canManage && access?.localMcpObservedAt !== undefined
        ? { localMcpObservedAt: access.localMcpObservedAt }
        : {}),
      ...(active ? { operationKeys: active.operationKeys, revision: active.revision } : {}),
      profiles: executor.profiles,
      ...(executor.scope.kind === 'project' ? { projectId: executor.scope.projectId } : {}),
      scopeKind: executor.scope.kind,
      status: executor.status,
      ...(executor.statusDetail ? { statusDetail: executor.statusDetail } : {}),
    }
  }))
}

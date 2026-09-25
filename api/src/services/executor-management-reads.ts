import { Prisma, type PrismaClient } from '@prisma/client'
import { buildAgentEntitlementWhere } from '@nessie/team-admin'
import { ExecutorError, EXECUTOR_ERROR_CODES, getExecutorForManagement } from '@nessie/executor-manage'
import {
  AgentIdSchema, buildPage, decodeKeysetCursor, IMPLEMENTED_EXECUTOR_OPERATION_KEYS, resolvePageLimit,
  type AuthorizedActionContext, type ExecutorAgentAccessListQuery, type ExecutorAgentAccessRecord,
  type ExecutorAttentionSummary, type PaginationMeta,
} from '@nessie/schemas'

export const listExecutorAgentAccess = async (
  prisma: PrismaClient, actor: AuthorizedActionContext, executorId: string,
  query: ExecutorAgentAccessListQuery, candidates = false,
): Promise<{ data: ExecutorAgentAccessRecord[]; meta: PaginationMeta }> => {
  const managed = await getExecutorForManagement(prisma, actor, executorId)
  if (!managed) {
    throw new ExecutorError(EXECUTOR_ERROR_CODES.NOT_FOUND, 'Executor not found.')
  }
  const cursor = decodeKeysetCursor(query.cursor)
  if (query.cursor && (!cursor || !AgentIdSchema.safeParse(cursor.id).success)) {
    throw new ExecutorError(EXECUTOR_ERROR_CODES.SCOPE_INVALID, 'Invalid agent page cursor.')
  }
  const linked: Prisma.AgentWhereInput = { OR: [
    ...(managed.executor.scope.kind === 'private'
      ? [{ executorPrivateAssignments: { some: { executorId, principalKind: 'agent' as const } } }] : []),
    { executorOperationGrants: { some: {
      executorId, state: 'allowed', operationKey: { in: [...IMPLEMENTED_EXECUTOR_OPERATION_KEYS] },
    } } },
  ] }
  const where: Prisma.AgentWhereInput = {
    organizationId: actor.tenant.organizationId, deletedAt: null,
    AND: [
      buildAgentEntitlementWhere({
        organizationId: actor.tenant.organizationId, userId: actor.actor.actorId, includeSystemManaged: true,
        includeUnbound: managed.access.organizationRole === 'owner' || managed.access.organizationRole === 'admin',
      }),
      candidates ? { NOT: linked } : linked,
      ...(candidates ? [{ OR: [
        { agentKind: 'personal_assistant' as const, systemManaged: true },
        { agentKind: 'shared' as const, systemManaged: false },
      ] }] : []),
      ...(query.q ? [{ name: { contains: query.q, mode: 'insensitive' as const } }] : []),
    ],
  }
  const backward = query.direction === 'backward'
  const boundary: Prisma.AgentWhereInput = cursor ? { OR: [
    { createdAt: backward ? { lt: cursor.createdAt } : { gt: cursor.createdAt } },
    { createdAt: cursor.createdAt, id: backward ? { lt: cursor.id } : { gt: cursor.id } },
  ] } : {}
  const limit = resolvePageLimit(query.limit)
  const [total, rows] = await prisma.$transaction([
    prisma.agent.count({ where }),
    prisma.agent.findMany({
      where: { AND: [where, boundary] }, take: limit + 1,
      orderBy: [{ createdAt: backward ? 'desc' : 'asc' }, { id: backward ? 'desc' : 'asc' }],
      select: {
        id: true, name: true, visibility: true, createdAt: true,
        executorPrivateAssignments: { where: { executorId, principalKind: 'agent' }, select: { id: true } },
        executorOperationGrants: {
          where: { executorId, state: 'allowed', operationKey: { in: [...IMPLEMENTED_EXECUTOR_OPERATION_KEYS] } },
          orderBy: { operationKey: 'asc' }, select: { operationKey: true },
        },
      },
    }),
  ], { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })
  const page = buildPage({ rows, total, limit, direction: query.direction, hasCursor: Boolean(cursor) })
  return { meta: page.meta, data: page.data.map((agent) => ({
    agentId: agent.id, name: agent.name, visibility: agent.visibility,
    assigned: managed.executor.scope.kind === 'private' && agent.executorPrivateAssignments.length > 0,
    allowedOperationKeys: agent.executorOperationGrants.map((grant) =>
      grant.operationKey as ExecutorAgentAccessRecord['allowedOperationKeys'][number]),
  })) }
}

/** Capability reports take effect immediately; no human review queue remains. */
export const getExecutorAttentionSummary = async (
  _prisma: PrismaClient, _actor: AuthorizedActionContext,
): Promise<ExecutorAttentionSummary> => ({ total: 0, executors: [] })

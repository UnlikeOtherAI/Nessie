import type { Prisma, PrismaClient } from '@prisma/client'
import { parseAgentId, parseRunId, type WsScope, type WsSnapshot } from '@nessie/schemas'
import {
  buildAccessibleChannelWhere,
  isSystemManagedAgent,
  type AgentVisibilityScope,
} from '@nessie/team-admin'

import { filterReadableAgentRuns } from './agent-read-disclosure.js'
import {
  buildAccessibleRunWhere,
  buildDisclosureReadableThreadWhere,
  toTimestamp,
} from './agent-read-primitives.js'

export const buildSnapshotForScopes = async (
  prisma: PrismaClient,
  scopes: WsScope[],
  options?: { visibility?: AgentVisibilityScope },
): Promise<WsSnapshot> => {
  if (scopes.length === 0) return { agents: [] }

  const agentIds = new Set<string>()
  const bindingOr: Prisma.AgentBindingWhereInput[] = []
  for (const scope of scopes) {
    if (scope.kind === 'agent') {
      agentIds.add(scope.agentId)
      continue
    }
    if (scope.kind === 'channel') {
      bindingOr.push({
        channelId: scope.channelId,
        ...(options?.visibility
          ? { channel: buildAccessibleChannelWhere(options.visibility) }
          : {}),
      })
      continue
    }
    if (scope.kind === 'user' || scope.kind === 'dashboard') continue
    bindingOr.push({
      channel: options?.visibility
        ? buildAccessibleChannelWhere(options.visibility)
        : { organizationId: scope.organizationId },
    })
  }

  if (bindingOr.length > 0) {
    const bindings = await prisma.agentBinding.findMany({
      where: { OR: bindingOr },
      select: { agentId: true },
    })
    bindings.forEach((binding) => agentIds.add(binding.agentId))
  }
  if (agentIds.size === 0) return { agents: [] }

  const runVisibilityWhere = buildAccessibleRunWhere(options?.visibility)
  const agents = await prisma.agent.findMany({
    where: {
      id: { in: Array.from(agentIds) },
      ...(options?.visibility ? { organizationId: options.visibility.organizationId } : {}),
    },
    include: {
      messages: {
        where: options?.visibility
          ? { thread: buildDisclosureReadableThreadWhere(options.visibility) }
          : {},
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
      runs: {
        include: { toolCalls: { orderBy: { startedAt: 'desc' }, take: 1 } },
        where: { ...runVisibilityWhere, status: { in: ['pending', 'running'] } },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
  })

  return {
    agents: await Promise.all(agents
      .filter((agent) => !isSystemManagedAgent(agent))
      .map(async (agent) => {
        const runs = await filterReadableAgentRuns(prisma, agent.runs, options?.visibility)
        const latestRun = runs[0]
        const latestToolCall = latestRun?.toolCalls[0]
        const isActiveRun = latestRun !== undefined
          && latestRun.status !== 'completed'
          && latestRun.status !== 'failed'
          && latestRun.status !== 'cancelled'
        return {
          agentId: parseAgentId(agent.id),
          status: agent.status,
          since: agent.updatedAt.toISOString(),
          currentRunId: isActiveRun ? parseRunId(latestRun.id) : undefined,
          currentToolName: isActiveRun && latestToolCall?.endedAt === null
            ? latestToolCall.toolName
            : undefined,
          currentToolStartedAt: isActiveRun && latestToolCall?.endedAt === null
            ? toTimestamp(latestToolCall.startedAt)
            : undefined,
        }
      })),
  }
}

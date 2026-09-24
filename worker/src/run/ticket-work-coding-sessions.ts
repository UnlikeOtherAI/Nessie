import type { PrismaClient } from '@prisma/client'
import {
  appendTicketWorkSession,
  executorCodingSessionOwnerKey,
  recordTicketWorkPullRequest,
  recordTicketWorkSessionObservation,
  reportedExecutorCodingSessions,
  type ObservedPullRequest,
} from '@nessie/executor-manage'
import type { ToolSchemaDescriptor } from '@nessie/runtime'
import {
  StandingPolicyHostProfileSchema,
  ticketWorkCodingSessionContext,
  type ExecutorCodingAgentName,
  type ExecutorCodingSessionsFacts,
} from '@nessie/schemas'
import { ticketWorkThreadTitle } from '@nessie/team-admin'

import { CODING_SESSION_TOOL_NAMES, codingSessionDescriptors, type CodingSessionToolName } from './coding-session-tools.js'
import type { CodingWaitTiming } from './coding-session-wait.js'
import type { CodingSessionHooks, ExecutorCodingSessions } from './executor-coding-sessions.js'
import { writeTicketWorkCodingAudit } from './ticket-work-coding-audit.js'
import { summarizeToolInput } from './tool-util.js'
import type { AgenticToolResult } from './tools.js'

/**
 * The coding tools of a `ticket.work` run bound under a standing policy
 * (docs/plans/2026-09-23-ticket-driven-agents/machine-access.md → "Session
 * isolation"; docs/standards/ticket-work-machine-access.md). The bridge
 * already isolates the ticket by its owner context; this is the worker's
 * defence in depth, and what makes the tools usable by a weak model:
 *
 * - a `sessionId` not on the work record is refused (*"That session is not
 *   this ticket's."*); it is optional, and defaults to the ticket's one open
 *   session;
 * - a start's title is always the ticket's own, and the session it returns is
 *   appended to the record in the same step; a start whose outcome was lost
 *   is found in the machine's next report by that title and the ticket's owner
 *   key;
 * - a start may use only the pinned coding agents (Claude Code: its turns
 *   have a budget) and the pinned roots;
 * - each tool is described by its purpose in ticket work, and a wait reads
 *   for at most a minute;
 * - every answer's cost, turn end and pull request are written to the record
 *   as they are seen, and a review asks after the recorded pull request by URL.
 */

export type TicketWorkCodingScope = {
  agentId: string
  allowedRootNames: readonly string[]
  codingAgents: readonly ExecutorCodingAgentName[]
  contextId: string
  executorId: string
  organizationId: string
  ownerKey: string
  policyId: string
  runId: string
  taskId: string
  title: string
  workId: string
}

/** A ticket-mode wait reads for about a minute, then hands back what it saw. */
export const TICKET_WORK_CODING_WAIT_TIMING: CodingWaitTiming = { timeoutMs: 90_000, windowMs: 60_000 }
export const TICKET_WORK_CODING_WAIT_TOOL_TIMEOUT_MS = 100_000

const TITLE_MAX = 120

/** The coding scope of a run the standing binder bound, or null for any other run. */
export const loadTicketWorkCodingScope = async (
  prisma: Pick<PrismaClient, 'agentTicketWork' | 'executorBinding'>,
  input: { runId: string; workId: string },
): Promise<TicketWorkCodingScope | null> => {
  const binding = await prisma.executorBinding.findFirst({
    where: { operationKey: 'mcp.call', runId: input.runId, standingPolicyId: { not: null }, ticketWorkId: input.workId },
    select: {
      executorId: true,
      standingPolicy: { select: { authorUserId: true, hostProfile: true, id: true } },
    },
  })
  const work = await prisma.agentTicketWork.findUnique({
    where: { id: input.workId },
    select: {
      agentId: true, organizationId: true, taskId: true,
      task: { select: { externalLink: { select: { externalKey: true } }, title: true } },
    },
  })
  const policy = binding?.standingPolicy
  const profile = StandingPolicyHostProfileSchema.safeParse(policy?.hostProfile)
  if (!binding || !policy || !work || !profile.success) return null
  const contextId = ticketWorkCodingSessionContext(policy.id, work.taskId)
  return {
    agentId: work.agentId,
    allowedRootNames: profile.data.allowedRootNames,
    codingAgents: profile.data.codingAgents,
    contextId,
    executorId: binding.executorId,
    organizationId: work.organizationId,
    ownerKey: executorCodingSessionOwnerKey(binding.executorId, {
      actorUserId: policy.authorUserId, agentId: work.agentId, contextId,
    }),
    policyId: policy.id,
    runId: input.runId,
    taskId: work.taskId,
    title: ticketWorkThreadTitle(work.task).slice(0, TITLE_MAX),
    workId: input.workId,
  }
}

const SESSION_TOOLS: ReadonlySet<string> = new Set([
  CODING_SESSION_TOOL_NAMES.close, CODING_SESSION_TOOL_NAMES.interrupt, CODING_SESSION_TOOL_NAMES.review,
  CODING_SESSION_TOOL_NAMES.send, CODING_SESSION_TOOL_NAMES.wait,
])

const TICKET_DESCRIPTIONS: Partial<Record<CodingSessionToolName, string>> = {
  coding_session_send: 'Give the coding agent new information or a correction, then end your turn. Leave sessionId '
    + 'out: it is this ticket\'s session.',
  coding_session_wait: 'Read what the session said at the end of its last turn. It returns at once. Do not use it to '
    + 'watch work in progress. Leave sessionId out: it is this ticket\'s session.',
}

/** The seven, described for ticket work: each by its purpose, sessionId optional, the start's title the ticket's. */
export const ticketWorkCodingDescriptors = (
  facts: ExecutorCodingSessionsFacts,
  scope: Pick<TicketWorkCodingScope, 'allowedRootNames' | 'codingAgents'>,
): ToolSchemaDescriptor[] => {
  const agents = facts.agents.filter((agent) => scope.codingAgents.includes(agent))
  const roots = facts.rootNames.filter((root) => scope.allowedRootNames.includes(root))
  return codingSessionDescriptors(facts).map((descriptor) => {
    const schema = descriptor.inputSchema as { properties: Record<string, unknown>; required?: string[] }
    if (descriptor.toolName === CODING_SESSION_TOOL_NAMES.start) {
      const properties = Object.fromEntries(Object.entries(schema.properties).filter(([key]) => key !== 'title'))
      return {
        ...descriptor,
        description: 'Start the coding agent for this ticket. Put the goal, the ticket id and link, the acceptance '
          + 'criteria and the pull-request and merge rule in the task. Then post one short ticket comment and end your '
          + `turn. Nessie wakes you here when its turn ends. It works in one of these folders: ${roots.join(', ')}.`,
        inputSchema: {
          ...schema,
          properties: { ...properties, agent: { enum: agents, type: 'string' }, root: { enum: roots, type: 'string' } },
        },
      }
    }
    if (!SESSION_TOOLS.has(descriptor.toolName)) return descriptor
    return {
      ...descriptor,
      description: TICKET_DESCRIPTIONS[descriptor.toolName as CodingSessionToolName] ?? descriptor.description,
      inputSchema: { ...schema, required: (schema.required ?? []).filter((key) => key !== 'sessionId') },
    }
  })
}

const refusal = (args: Record<string, unknown>, output: string): AgenticToolResult => ({
  correctable: true, inputSummary: summarizeToolInput(args), output, success: false,
})

/**
 * The ticket's sessions as the record and the machine's last report hold
 * them: a start whose answer was lost is taken back onto the record here, by
 * its forced title under the ticket's own owner key.
 */
const ticketSessions = async (
  prisma: PrismaClient,
  scope: TicketWorkCodingScope,
): Promise<{ live: string[]; recorded: string[] }> => {
  const [work, executor] = await Promise.all([
    prisma.agentTicketWork.findUnique({ where: { id: scope.workId }, select: { sessionIds: true } }),
    prisma.executor.findUnique({ where: { id: scope.executorId }, select: { localMcp: true } }),
  ])
  const recorded = [...(work?.sessionIds ?? [])]
  const reported = reportedExecutorCodingSessions(executor?.localMcp)
    .filter((session) => session.ownerKey === scope.ownerKey)
  for (const session of reported) {
    if (!recorded.includes(session.sessionId) && session.title === scope.title) {
      await appendTicketWorkSession(prisma, { sessionId: session.sessionId, workId: scope.workId })
      recorded.push(session.sessionId)
    }
  }
  const open = new Set(reported.filter((session) => session.status !== 'closed').map((session) => session.sessionId))
  const live = reported.length > 0 || executor?.localMcp ? recorded.filter((id) => open.has(id)) : recorded
  return { live, recorded }
}

/** What the record learns from one answer, in the same step. */
export const ticketWorkCodingObserver = (prisma: PrismaClient, scope: TicketWorkCodingScope) => async (
  toolName: CodingSessionToolName, args: Record<string, unknown>, body: Record<string, unknown>,
): Promise<void> => {
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId
    : typeof args.sessionId === 'string' ? args.sessionId : null
  if (toolName === CODING_SESSION_TOOL_NAMES.start && sessionId && body.replayed !== true) {
    await appendTicketWorkSession(prisma, { sessionId, workId: scope.workId })
    await writeTicketWorkCodingAudit(prisma, scope, { action: 'executor.coding_session.started', sessionId })
  }
  if (toolName === CODING_SESSION_TOOL_NAMES.close && sessionId) {
    await writeTicketWorkCodingAudit(prisma, scope, { action: 'executor.coding_session.closed', sessionId })
  }
  if (toolName === CODING_SESSION_TOOL_NAMES.send && sessionId) {
    await writeTicketWorkCodingAudit(prisma, scope, { action: 'executor.coding_session.sent', sessionId })
  }
  if (sessionId) {
    await recordTicketWorkSessionObservation(prisma, {
      sessionId, workId: scope.workId,
      ...(typeof body.status === 'string' ? { status: body.status } : {}),
      ...(typeof body.totalCostUsd === 'number' ? { totalCostUsd: body.totalCostUsd } : {}),
      ...(typeof body.turn === 'number' ? { turn: body.turn } : {}),
    })
  }
  if (toolName === CODING_SESSION_TOOL_NAMES.review) {
    const byBranch = body.pullRequests && typeof body.pullRequests === 'object' && !Array.isArray(body.pullRequests)
      ? Object.values(body.pullRequests as Record<string, ObservedPullRequest>)
      : []
    const byUrl = body.pullRequest && typeof body.pullRequest === 'object' ? [body.pullRequest as ObservedPullRequest] : []
    await recordTicketWorkPullRequest(prisma, { pullRequests: [...byUrl, ...byBranch], workId: scope.workId })
  }
}

/** The ticket's own rules in front of every call. */
export const ticketWorkCodingSessions = (
  prisma: PrismaClient,
  base: ExecutorCodingSessions,
  scope: TicketWorkCodingScope,
): ExecutorCodingSessions => ({
  ...base,
  execute: async (toolName, rawArgs, providerToolCallId, hooks?: CodingSessionHooks) => {
    const args = { ...rawArgs }
    if (toolName === CODING_SESSION_TOOL_NAMES.start) {
      const agent = typeof args.agent === 'string' && args.agent.trim() ? args.agent : scope.codingAgents[0]
      if (!agent || !scope.codingAgents.includes(agent as ExecutorCodingAgentName)) {
        return refusal(args, 'Ticket work runs Claude Code only: its turns have a spending limit, and the machine\'s '
          + 'owner agreed to exactly that.')
      }
      if (typeof args.root !== 'string' || !scope.allowedRootNames.includes(args.root)) {
        return refusal(args, `Ticket work may use only these coding roots: ${scope.allowedRootNames.join(', ')}.`)
      }
      return base.execute(toolName, { ...args, agent, title: scope.title }, providerToolCallId, hooks)
    }
    if (!SESSION_TOOLS.has(toolName)) return base.execute(toolName, args, providerToolCallId, hooks)
    const sessions = await ticketSessions(prisma, scope)
    const named = typeof args.sessionId === 'string' && args.sessionId.trim() ? args.sessionId : null
    if (named && !sessions.recorded.includes(named)) {
      return refusal(args, 'That session is not this ticket\'s. Leave sessionId out to use this ticket\'s own session.')
    }
    if (!named) {
      if (sessions.live.length === 0) {
        return refusal(args, 'This ticket has no open coding session yet. Start one with coding_session_start.')
      }
      if (sessions.live.length > 1) {
        return refusal(args, `This ticket has more than one open coding session (${sessions.live.join(', ')}): name `
          + 'the sessionId.')
      }
      args.sessionId = sessions.live[0]
    }
    if (toolName === CODING_SESSION_TOOL_NAMES.review && !args.pullRequest) {
      const work = await prisma.agentTicketWork.findUnique({
        where: { id: scope.workId }, select: { pullRequestUrl: true },
      })
      if (work?.pullRequestUrl) args.pullRequest = work.pullRequestUrl
    }
    return base.execute(toolName, args, providerToolCallId, hooks)
  },
})

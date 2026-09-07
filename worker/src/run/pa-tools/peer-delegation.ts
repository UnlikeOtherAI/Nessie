import { canAdministerProject, createBoard } from '@nessie/team-admin'
import { Prisma } from '@prisma/client'
import { z } from 'zod'

import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import { BasisScopeSchema } from '../execute/disclosure-basis.js'
import { resolveActingMember } from './access.js'

const MAX_PEER_DELEGATION_DEPTH = 4
const DelegateInput = z.object({ agentId: z.string().uuid(), brief: z.string().trim().min(1).max(8_000) })
const BoardInput = z.object({ name: z.string().trim().min(1).max(120), iconEmoji: z.string().nullable().optional(), style: z.enum(['kanban', 'scrum']).optional() })

const requesterAndProject = async (context: BuiltinToolRuntimeContext) => {
  const projectId = context.channel.projectId
  if (!projectId) throw new Error('This capability is available only inside a project channel.')
  if (context.agentKind !== 'shared' || context.actorContext.actor.actorType !== 'user') {
    throw new Error('Only an ordinary agent on behalf of the requesting person may collaborate here.')
  }
  const effectiveUserId = context.actorContext.actionContext.effectiveUserId
  if (effectiveUserId && effectiveUserId !== context.actorContext.actor.actorId) {
    throw new Error('The requester identity does not match this durable delegation.')
  }
  const binding = await context.prisma.agentBinding.count({
    where: { agentId: context.agentId, channelId: context.channel.id },
  })
  if (binding === 0) throw new Error('This agent is no longer bound to this project channel.')
  const member = await resolveActingMember(context)
  if (!(await canAdministerProject(context.prisma, member, projectId))) {
    throw new Error('A current project administrator must authorize this collaboration.')
  }
  return { member, projectId }
}

export const runAgentPeerDelegateTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = DelegateInput.parse(input)
  const depth = context.run.peerDelegationDepth ?? 0
  if (depth >= MAX_PEER_DELEGATION_DEPTH) {
    throw new Error('This review has reached its bounded peer-delegation limit.')
  }
  const { member, projectId } = await requesterAndProject(context)
  const target = await context.prisma.agent.findFirst({
    where: {
      id: args.agentId,
      organizationId: member.organizationId,
      systemManaged: false,
      agentKind: 'shared',
      agentBindings: { some: { channelId: context.channel.id } },
    },
    select: { id: true, name: true },
  })
  if (!target || target.id === context.agentId) {
    throw new Error('Choose another ordinary agent already bound to this project channel.')
  }
  const correlationId = `peer:${context.run.id}:${context.toolCallId ?? args.agentId}`
  const basis = BasisScopeSchema.array().parse(context.consumedSources?.list() ?? [])
  let mail: { id: string }
  try {
    mail = await context.prisma.agentMailboxMessage.create({
      data: {
        actorId: member.userId,
        actorType: 'user',
        basis: basis as Prisma.InputJsonValue,
        body: args.brief,
        channelId: context.channel.id,
        correlationId,
        fromAgentId: context.agentId,
        organizationId: member.organizationId,
        peerDelegationDepth: depth + 1,
        subject: `Project review: ${projectId}`,
        threadId: context.run.threadId,
        toAgentId: target.id,
      },
      select: { id: true },
    })
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error
    const existing = await context.prisma.agentMailboxMessage.findFirst({
      where: { correlationId, organizationId: member.organizationId, toAgentId: target.id }, select: { id: true },
    })
    if (!existing) throw error
    mail = existing
  }
  return { toolName: 'agent_peer_delegate', inputSummary: `agentId=${target.id}`, outputPreview: `Asked ${target.name} for a bounded project review. mailboxMessageId=${mail.id} depth=${depth + 1}` }
}

export const runTicketBoardCreateTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = BoardInput.parse(input)
  const { member, projectId } = await requesterAndProject(context)
  const board = await createBoard(
    context.prisma,
    { id: projectId, organizationId: member.organizationId },
    { ...args, createdByUserId: member.userId },
  )
  if ('error' in board) throw new Error('Unable to create this board.')
  return {
    toolName: 'ticket_board_create',
    inputSummary: `projectId=${projectId} name=${args.name}`,
    outputPreview: `Created board \"${board.name}\" | boardId=${board.id}`,
  }
}

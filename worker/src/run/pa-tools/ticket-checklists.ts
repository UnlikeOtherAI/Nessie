import {
  applyTaskChecklistTemplate,
  getTaskChecklist,
  isAgentAccessibleToActor,
  publishTaskUpdated,
  updateTaskChecklistStep,
} from '@nessie/team-admin'
import { z } from 'zod'

import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import { resolveActingMember } from './access.js'
import { buildScopes } from '../execute/scopes.js'
import { IdSchema, projectTicketFor, recordProjectRead, result } from './ticket-context.js'

const ReadInput = z.object({ ticketId: IdSchema })
const ApplyInput = z.object({ templateId: IdSchema, ticketId: IdSchema })
const StepUpdateInput = z.object({
  completed: z.boolean(),
  result: z.string().max(10_000).nullable().optional(),
  stepKey: z.string().trim().min(1),
  ticketId: IdSchema,
})

const checklistText = (checklist: {
  id: string
  steps: Array<{
    completedAt: string | null
    instructions: string
    key: string
    result: string | null
    title: string
  }>
  title: string
}): string => [
  `Checklist "${checklist.title}" | checklistId=${checklist.id}`,
  ...checklist.steps.map((step) => [
    `- ${step.title} | stepKey=${step.key} completed=${step.completedAt !== null}`,
    `  Instructions: ${step.instructions}`,
    `  Result: ${step.result ?? 'none'}`,
  ].join('\n')),
].join('\n')

export const assertProjectChecklistDestination = async (
  context: BuiltinToolRuntimeContext,
  input: {
    agentId?: string
    organizationId: string
    projectId: string
    taskUserIds?: Array<string | null>
  },
): Promise<void> => {
  const members = await context.prisma.projectMember.findMany({
    where: { projectId: input.projectId },
    select: { userId: true },
  })
  const projectMemberIds = new Set(members.map(({ userId }) => userId))
  const taskUserIds = new Set(input.taskUserIds?.filter((id): id is string => id !== null) ?? [])
  const organizationMembers = await context.prisma.organizationMember.findMany({
    where: { deactivatedAt: null, organizationId: input.organizationId },
    select: { role: true, userId: true },
  })
  const readers = organizationMembers.filter(({ role, userId }) => (
    role === 'owner' || projectMemberIds.has(userId) || taskUserIds.has(userId)
  ))
  const audienceCanSeeAgent = async (agentId: string): Promise<boolean> => {
    const visible = await Promise.all(readers.map(async ({ role, userId }) => (
      isAgentAccessibleToActor(context.prisma, {
        ...context.actorContext,
        actor: { ...context.actorContext.actor, actorId: userId, roles: [role] },
      }, agentId)
    )))
    return !visible.includes(false)
  }
  const carried = context.consumedSources?.list() ?? []
  for (const scope of carried) {
    const implied = (scope.scopeType === 'organization' && scope.scopeId === input.organizationId)
      || (scope.scopeType === 'project' && scope.scopeId === input.projectId)
      || (scope.scopeType === 'agent' && await audienceCanSeeAgent(scope.scopeId))
    if (!implied) throw new Error('I cannot copy restricted research into this shared ticket checklist.')
  }
  if (input.agentId && !(await audienceCanSeeAgent(input.agentId))) {
    throw new Error('This template is private to an agent some project collaborators cannot access.')
  }
}

const publishChecklistTask = async (
  context: BuiltinToolRuntimeContext,
  task: {
    id: string
    status: 'inbox' | 'assigned' | 'in_progress' | 'review' | 'done' | 'failed' | 'cancelled' | 'awaiting_approval'
  },
): Promise<void> => {
  if (context.runContext) {
    await publishTaskUpdated(context.realtimeTransport, buildScopes(context.runContext), task.id, task.status)
  }
}

export const runTicketChecklistReadTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const { ticketId } = ReadInput.parse(input)
  const member = await resolveActingMember(context)
  const ticket = await projectTicketFor(context, member, ticketId)
  const checklist = await getTaskChecklist(context.prisma, {
    organizationId: member.organizationId,
    taskId: ticket.id,
  })
  recordProjectRead(context, member, ticket.projectId!)
  return result(
    'ticket_checklist_read',
    `ticketId=${ticketId}`,
    checklist ? checklistText(checklist) : 'This ticket has no checklist yet.',
  )
}

export const runTicketChecklistApplyTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const { templateId, ticketId } = ApplyInput.parse(input)
  const member = await resolveActingMember(context)
  const ticket = await projectTicketFor(context, member, ticketId)

  // This is the route's source gate, paired with projectTicketFor's destination
  // gate above. Check the destination before the template is read, and never
  // let a generic agent context turn a private template into a project snapshot.
  if (!(await isAgentAccessibleToActor(context.prisma, member.actorContext, context.agentId))) {
    throw new Error('Agent not found.')
  }
  await assertProjectChecklistDestination(context, {
    agentId: context.agentId,
    organizationId: member.organizationId,
    projectId: ticket.projectId!,
    taskUserIds: [ticket.assigneeUserId, ticket.ownerUserId],
  })
  const checklist = await applyTaskChecklistTemplate(context.prisma, {
    agentId: context.agentId,
    createdByUserId: member.userId,
    organizationId: member.organizationId,
    taskId: ticket.id,
    templateId,
  })
  if ('error' in checklist) {
    throw new Error(checklist.error === 'TASK_NOT_FOUND' ? 'Ticket not found.' : 'Template not found.')
  }

  // The template's instructions entered the run context to create the task
  // snapshot. A task is project-scoped, while a template can be private to its
  // agent, so retain both sources for the run reply.
  recordProjectRead(context, member, ticket.projectId!)
  context.consumedSources?.add({ scopeId: context.agentId, scopeType: 'agent' })
  await publishChecklistTask(context, ticket)
  return result('ticket_checklist_apply', `ticketId=${ticketId} templateId=${templateId}`, checklistText(checklist))
}

export const runTicketChecklistStepUpdateTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = StepUpdateInput.parse(input)
  const member = await resolveActingMember(context)
  const ticket = await projectTicketFor(context, member, args.ticketId)
  await assertProjectChecklistDestination(context, {
    organizationId: member.organizationId,
    projectId: ticket.projectId!,
  })
  const checklist = await getTaskChecklist(context.prisma, {
    organizationId: member.organizationId,
    taskId: ticket.id,
  })
  if (!checklist) throw new Error('This ticket has no checklist yet.')
  const updated = await updateTaskChecklistStep(context.prisma, {
    checklistId: checklist.id,
    completed: args.completed,
    organizationId: member.organizationId,
    result: args.result,
    stepKey: args.stepKey,
    taskId: ticket.id,
  })
  if (!updated) throw new Error('Checklist step not found.')
  recordProjectRead(context, member, ticket.projectId!)
  await publishChecklistTask(context, ticket)
  return result(
    'ticket_checklist_step_update',
    `ticketId=${args.ticketId} stepKey=${args.stepKey}`,
    checklistText(updated),
  )
}

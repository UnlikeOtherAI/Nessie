import type { ProjectTaskRecord } from '@nessie/team-admin'
import { getProjectTask, isProjectAccessibleToUser } from '@nessie/team-admin'
import { z } from 'zod'

import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import type { ActingMember } from './access.js'

/**
 * What every ticket tool needs before and after it touches a ticket: the
 * shared argument vocabulary, the project gate, the disclosure basis, and the
 * one line a ticket is rendered as.
 *
 * These are shared because they are decisions, not conveniences — a second
 * spelling of the project gate or of the disclosure stamp is how one tool ends
 * up answering a question another tool would refuse.
 */

export const TicketStatusSchema = z.enum([
  'inbox',
  'assigned',
  'in_progress',
  'review',
  'done',
  'failed',
  'cancelled',
  'awaiting_approval',
])

export const PrioritySchema = z.enum(['low', 'medium', 'high', 'urgent'])
export const IdSchema = z.string().uuid()

export const projectFor = async (
  context: BuiltinToolRuntimeContext,
  member: ActingMember,
  projectId: string,
): Promise<void> => {
  if (!(await isProjectAccessibleToUser(context.prisma, member, projectId))) {
    throw new Error('Project not found. Resolve it with project_list first.')
  }
}

export const projectTicketFor = async (
  context: BuiltinToolRuntimeContext,
  member: ActingMember,
  ticketId: string,
): Promise<ProjectTaskRecord> => {
  const ticket = await getProjectTask(context.prisma, ticketId, member.organizationId)
  if (!ticket?.projectId) {
    throw new Error('Ticket not found. Resolve it with ticket_list first.')
  }
  await projectFor(context, member, ticket.projectId)
  return ticket
}

export const recordProjectRead = (
  context: BuiltinToolRuntimeContext,
  member: ActingMember,
  projectId: string,
): void => {
  // Owners reach every project by their organization role, so applying a
  // membership-only project basis would withhold this PA reply from its owner.
  if (!member.isOwner) {
    context.consumedSources?.add({ scopeId: projectId, scopeType: 'project' })
  }
}

export const ticketLine = (ticket: ProjectTaskRecord): string =>
  [
    `- ${ticket.title ?? 'Untitled'} | ticketId=${ticket.id}`,
    `  status=${ticket.status} priority=${ticket.priority}`,
    `  assignee=${ticket.assigneeName ?? 'unassigned'} due=${ticket.dueDate ?? 'none'}`,
  ].join('\n')

export const result = (
  toolName: string,
  inputSummary: string,
  outputPreview: string,
): ToolExecutionResult => ({ toolName, inputSummary, outputPreview })

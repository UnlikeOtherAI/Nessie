import {
  createTaskComment,
  createTaskCommentWriteBackFromSource,
  deleteTaskComment,
  listTaskComments,
  publishTaskActivity,
  updateTaskComment,
  type TaskActor,
  type TaskCommentWriteBack,
} from '@nessie/team-admin'
import { attributionFromActorContext } from '@nessie/runtime'
import { TASK_COMMENT_MAX_CHARS, type TaskCommentAuthor, type TaskCommentRecord } from '@nessie/schemas'
import { z } from 'zod'

import { fileServiceFor } from '../file-service.js'
import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import { resolveActingMember, type ActingMember } from './access.js'
import {
  assertProjectWriteDestination,
  IdSchema,
  projectTicketFor,
  recordProjectRead,
  result,
} from './ticket-context.js'

/**
 * A ticket's comments, for the Personal Assistant and — the list and add
 * halves — for a shared agent working in its project channel.
 *
 * Every tool calls the function the comment routes call. Who is acting is
 * decided here once: the member whose reach is checked is always the person
 * (the PA's owner, or the person who asked a shared agent), but a shared
 * agent writes *as itself* — the comment's author is the agent, and the
 * ticket history's `by` is the person who asked it. A PA is its person's
 * delegate and writes as them.
 */

/** The actor the shared ticket functions take, for this run. */
export const ticketActorFor = (
  context: BuiltinToolRuntimeContext,
  member: ActingMember,
): TaskActor => ({
  organizationId: member.organizationId,
  userId: member.userId,
  isOrganizationAdmin: member.isOrganizationAdmin,
  ...(context.agentKind === 'shared' ? { agentId: context.agentId } : {}),
})

/**
 * The comment write-back collaborator, built by the one shared builder the
 * API's comment routes use, so an agent's comment reaches the provider
 * exactly as a person's does. Absent key ring: comments stay in Nessie.
 */
const commentWriteBackFor = (context: BuiltinToolRuntimeContext): TaskCommentWriteBack | undefined =>
  context.boardSourceEncryptionSecret
    ? createTaskCommentWriteBackFromSource({
        prisma: context.prisma,
        encryptionSecret: context.boardSourceEncryptionSecret,
      })
    : undefined

/** An open ticket dialog refreshes on this, whoever changed the ticket. */
export const announceTicketActivity = async (
  context: BuiltinToolRuntimeContext,
  input: { organizationId: string; taskId: string; projectId: string | null },
): Promise<void> => {
  await publishTaskActivity(context.realtimeTransport, input)
}

const REFUSALS: Record<string, string> = {
  NOT_FOUND: 'Ticket not found. Resolve it with ticket_list first.',
  COMMENT_NOT_FOUND: 'Comment not found on this ticket. Read them with ticket_comment_list.',
  COMMENT_NOT_AUTHOR: 'Only its author can change a comment.',
  COMMENT_NOT_WRITABLE: 'This comment came from an external system that cannot change it from Nessie.',
  CURSOR_INVALID: 'That cursor is not one ticket_comment_list returned.',
}

/** A shared function's refusal, said in words. */
export const refuse = (outcome: { error: string; detail?: string }, words = REFUSALS): never => {
  throw new Error(outcome.detail ?? words[outcome.error] ?? `That change was refused (${outcome.error}).`)
}

const PROVIDER_NAMES: Record<string, string> = { github: 'GitHub', jira: 'Jira', linear: 'Linear', trello: 'Trello' }
const providerName = (provider: string): string => PROVIDER_NAMES[provider] ?? provider

const authorText = (author: TaskCommentAuthor): string => {
  switch (author.kind) {
    case 'user':
      return `person userId=${author.userId}`
    case 'agent':
      return `agent agentId=${author.agentId}`
    default:
      return `provider user "${author.displayName}" (${author.provider}, externalUserId=${author.externalUserId})`
  }
}

const commentText = (comment: TaskCommentRecord): string => [
  `- commentId=${comment.id} by ${authorText(comment.author)} at ${comment.createdAt}`
    + `${comment.editedAt ? ' (edited)' : ''}${comment.external ? ` [${comment.external.provider}]` : ' [Nessie]'}`,
  ...comment.body.split('\n').map((line) => `  ${line}`),
  ...comment.attachments.map((file) => `  file: ${file.filename} | attachmentId=${file.id}`),
].join('\n')

const ListInput = z.object({
  ticketId: IdSchema,
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
})

export const runTicketCommentListTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = ListInput.parse(input)
  const member = await resolveActingMember(context)
  const ticket = await projectTicketFor(context, member, args.ticketId)
  const listed = await listTaskComments(context.prisma, ticketActorFor(context, member), {
    taskId: ticket.id,
    ...(args.cursor ? { cursor: args.cursor } : {}),
    ...(args.limit ? { limit: args.limit } : {}),
  })
  if ('error' in listed) return refuse(listed)
  const page = listed
  // Comments are project material: reading them into the run is a read of
  // the project, stamped exactly as ticket_read stamps it.
  recordProjectRead(context, member, ticket.projectId!)
  const output = page.comments.length
    ? [
        `Comments (${page.comments.length} of ${page.total})`,
        ...page.comments.map(commentText),
        ...(page.nextCursor ? [`More: pass cursor=${page.nextCursor}`] : []),
      ].join('\n')
    : 'This ticket has no comments.'
  return result('ticket_comment_list', `ticketId=${args.ticketId}`, output)
}

const AddInput = z.object({ ticketId: IdSchema, body: z.string().trim().min(1).max(TASK_COMMENT_MAX_CHARS) })

export const runTicketCommentAddTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = AddInput.parse(input)
  const member = await resolveActingMember(context)
  const ticket = await projectTicketFor(context, member, args.ticketId)
  await assertProjectWriteDestination(context, {
    organizationId: member.organizationId,
    projectId: ticket.projectId!,
    taskUserIds: [ticket.assigneeUserId, ticket.ownerUserId],
  })
  const created = await createTaskComment(
    context.prisma,
    ticketActorFor(context, member),
    { taskId: ticket.id, body: args.body },
    { writeBack: commentWriteBackFor(context) },
  )
  if ('error' in created) return refuse(created)
  const { comment, projectId, propagated } = created
  await announceTicketActivity(context, { organizationId: member.organizationId, taskId: ticket.id, projectId })
  const link = ticket.externalLink
  const provider = link ? providerName(link.provider) : ''
  const where = !link
    ? null
    : propagated
      ? `Posted to ${provider} too.`
      : link.writeMode === 'read_write'
        ? `${provider} cannot take comments from Nessie; the comment stays in Nessie.`
        : `This ticket mirrors ${provider} read-only; the comment stays in Nessie.`
  return result(
    'ticket_comment_add',
    `ticketId=${args.ticketId}`,
    [`Added comment | commentId=${comment.id}`, ...(where ? [where] : [])].join('\n'),
  )
}

const UpdateInput = z.object({
  ticketId: IdSchema,
  commentId: IdSchema,
  body: z.string().trim().min(1).max(TASK_COMMENT_MAX_CHARS),
})

export const runTicketCommentUpdateTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = UpdateInput.parse(input)
  const member = await resolveActingMember(context)
  const ticket = await projectTicketFor(context, member, args.ticketId)
  await assertProjectWriteDestination(context, {
    organizationId: member.organizationId,
    projectId: ticket.projectId!,
    taskUserIds: [ticket.assigneeUserId, ticket.ownerUserId],
  })
  const updated = await updateTaskComment(
    context.prisma,
    ticketActorFor(context, member),
    { taskId: ticket.id, commentId: args.commentId, body: args.body },
    { writeBack: commentWriteBackFor(context) },
  )
  if ('error' in updated) return refuse(updated)
  const { projectId } = updated
  await announceTicketActivity(context, { organizationId: member.organizationId, taskId: ticket.id, projectId })
  return result('ticket_comment_update', `ticketId=${args.ticketId} commentId=${args.commentId}`, 'Updated comment.')
}

const DeleteInput = z.object({ ticketId: IdSchema, commentId: IdSchema })

export const runTicketCommentDeleteTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = DeleteInput.parse(input)
  const member = await resolveActingMember(context)
  const ticket = await projectTicketFor(context, member, args.ticketId)
  const deleted = await deleteTaskComment(
    context.prisma,
    ticketActorFor(context, member),
    { taskId: ticket.id, commentId: args.commentId },
    {
      fileService: fileServiceFor(context.prisma),
      attribution: attributionFromActorContext(context.actorContext),
      writeBack: commentWriteBackFor(context),
    },
  )
  if ('error' in deleted) return refuse(deleted)
  const { projectId } = deleted
  await announceTicketActivity(context, { organizationId: member.organizationId, taskId: ticket.id, projectId })
  return result('ticket_comment_delete', `ticketId=${args.ticketId} commentId=${args.commentId}`, 'Deleted comment.')
}

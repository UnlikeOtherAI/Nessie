import {
  linkTaskAttachments,
  listTaskAttachments,
  removeTaskAttachment,
} from '@nessie/team-admin'
import {
  inlineAttachmentPath,
  TASK_ATTACHMENT_REMOVE_REASON_MAX_CHARS,
  type TaskAttachmentRecord,
} from '@nessie/schemas'
import { z } from 'zod'

import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import { resolveActingMember } from './access.js'
import { resolveTicketMember } from './ticket-member.js'
import {
  assertProjectWriteDestination,
  IdSchema,
  projectTicketFor,
  recordProjectRead,
  result,
} from './ticket-context.js'
import { announceTicketActivity, refuse, ticketActorFor } from './ticket-comments.js'

/**
 * A ticket's files. Bytes arrive through `attachment_upload` (the agent's
 * upload door) and are linked here through the same door a person's
 * Attachments section uses; bytes reach a run's context only through
 * `attachment_read`, whose access is the ticket's. Removing a file marks it:
 * it stays on the ticket, downloadable, and the list says who removed it.
 */

const REFUSALS: Record<string, string> = {
  NOT_FOUND: 'Ticket not found. Resolve it with ticket_list first.',
  ATTACHMENT_NOT_ON_TASK: 'That file is not on this ticket. Read them with ticket_attachment_list.',
  ATTACHMENT_NOT_REMOVABLE: 'That file is a copy the external source keeps; it cannot be removed here.',
  ATTACHMENT_ALREADY_REMOVED: 'That file is already marked as removed.',
}

/** "3 minutes ago", "2 hours ago", "5 days ago" — coarse, for a line a model reads. */
export const relativeTime = (at: string, now: Date = new Date()): string => {
  const seconds = Math.max(0, Math.round((now.getTime() - new Date(at).getTime()) / 1000))
  const units: [number, string][] = [[86_400, 'day'], [3_600, 'hour'], [60, 'minute']]
  for (const [size, unit] of units) {
    const count = Math.floor(seconds / size)
    if (count >= 1) return `${count} ${unit}${count === 1 ? '' : 's'} ago`
  }
  return 'just now'
}

const removerText = (removed: NonNullable<TaskAttachmentRecord['removed']>): string =>
  removed.byUserId
    ? `person userId=${removed.byUserId}`
    : removed.byAgentId
      ? `agent agentId=${removed.byAgentId}`
      : 'unknown'

/** The tail a removed file's line ends with. */
export const removedText = (removed: NonNullable<TaskAttachmentRecord['removed']>, now?: Date): string =>
  ` REMOVED ${relativeTime(removed.at, now)} by ${removerText(removed)}`
  + `${removed.reason ? ` — "${removed.reason}"` : ''}`

const fileLine = (file: TaskAttachmentRecord): string =>
  file.kind === 'link'
    ? `- ${file.filename} | link=${file.downloadPath}${file.external ? ` (${file.external.provider}, ${file.external.status})` : ''}`
    : `- ${file.filename} | attachmentId=${file.id} mime=${file.mime} sizeBytes=${file.sizeBytes}`
      + `${file.inline ? ' (shown in the description or a comment)' : ''}`
      + `${file.commentId ? ` commentId=${file.commentId}` : ''}`
      + `${file.removed ? removedText(file.removed) : ''}`

const TicketInput = z.object({ ticketId: IdSchema })

export const runTicketAttachmentListTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const { ticketId } = TicketInput.parse(input)
  const member = await resolveTicketMember(context)
  const ticket = await projectTicketFor(context, member, ticketId)
  const listed = await listTaskAttachments(context.prisma, ticketActorFor(context, member), { taskId: ticket.id })
  if ('error' in listed) return refuse(listed, REFUSALS)
  // File names and links are project material, stamped as ticket_read is.
  recordProjectRead(context, member, ticket.projectId!)
  const removedCount = listed.attachments.filter((file) => file.removed).length
  const liveCount = listed.attachments.length - removedCount
  return result(
    'ticket_attachment_list',
    `ticketId=${ticketId}`,
    listed.attachments.length
      ? `Files (${liveCount})${removedCount > 0 ? ` (${removedCount} removed)` : ''}\n`
        + listed.attachments.map(fileLine).join('\n')
      : 'This ticket has no files.',
  )
}

const FileInput = z.object({ ticketId: IdSchema, attachmentId: IdSchema })

export const runTicketAttachmentAddTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = FileInput.parse(input)
  const member = await resolveActingMember(context)
  const ticket = await projectTicketFor(context, member, args.ticketId)
  await assertProjectWriteDestination(context, {
    organizationId: member.organizationId,
    projectId: ticket.projectId!,
    taskUserIds: [ticket.assigneeUserId, ticket.ownerUserId],
  })
  const linked = await linkTaskAttachments(context.prisma, ticketActorFor(context, member), {
    taskId: ticket.id,
    attachmentIds: [args.attachmentId],
  })
  if ('error' in linked) return refuse(linked, REFUSALS)
  const file = linked.attachments[0]
  if (!file) {
    // The shared door links only the actor's own uploads that nothing else
    // holds yet, and skips the rest — say which files qualify.
    throw new Error(
      'That file could not be attached. Only a file uploaded in this conversation with '
      + 'attachment_upload, and not yet sent in a message, can be attached to a ticket.',
    )
  }
  await announceTicketActivity(context, {
    organizationId: member.organizationId,
    taskId: ticket.id,
    projectId: linked.projectId,
  })
  return result(
    'ticket_attachment_add',
    `ticketId=${args.ticketId} attachmentId=${args.attachmentId}`,
    [
      `Attached ${file.filename} | attachmentId=${file.id}`,
      `To show it inline in the description or a comment: ![${file.filename.replace(/[[\]]/g, '')}](${inlineAttachmentPath(file.id)})`,
    ].join('\n'),
  )
}

const RemoveInput = FileInput.extend({
  reason: z.string().trim().max(TASK_ATTACHMENT_REMOVE_REASON_MAX_CHARS).optional(),
})

export const runTicketAttachmentRemoveTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = RemoveInput.parse(input)
  const member = await resolveActingMember(context)
  const ticket = await projectTicketFor(context, member, args.ticketId)
  const removed = await removeTaskAttachment(
    context.prisma,
    ticketActorFor(context, member),
    { taskId: ticket.id, attachmentId: args.attachmentId, reason: args.reason ?? null },
  )
  if ('error' in removed) return refuse(removed, REFUSALS)
  await announceTicketActivity(context, {
    organizationId: member.organizationId,
    taskId: ticket.id,
    projectId: removed.projectId,
  })
  return result(
    'ticket_attachment_remove',
    `ticketId=${args.ticketId} attachmentId=${args.attachmentId}`,
    `Marked ${removed.attachment.filename} as removed. It stays downloadable; the ticket shows who removed it and why.`,
  )
}

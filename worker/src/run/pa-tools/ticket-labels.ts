import {
  createProjectLabel,
  isTaskLabelError,
  listProjectLabels,
  publishProjectBoardUpdated,
} from '@nessie/team-admin'
import { TASK_LABEL_NAME_MAX_CHARS, type TaskLabelRecord } from '@nessie/schemas'
import { z } from 'zod'

import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import { resolveActingMember } from './access.js'
import {
  assertProjectWriteDestination,
  IdSchema,
  projectFor,
  recordProjectRead,
  result,
} from './ticket-context.js'

/**
 * A project's labels: the read that resolves `labelIds` for ticket_create and
 * ticket_update, and creating one. Renaming, recolouring and deleting are
 * board administration and live on the project's settings page, as the
 * boards design keeps field and source administration off the PA.
 *
 * `projectFor` is the route's `requireProjectModifier`: under the project
 * model the people who may change a project are the people who may read it.
 */

const labelLine = (label: TaskLabelRecord): string =>
  `- ${label.name} | labelId=${label.id} color=${label.color}`
  + `${label.source ? ` owned by ${label.source.provider}` : ''}`
  + `${label.taskCount !== undefined ? ` tickets=${label.taskCount}` : ''}`

const ReadInput = z.object({ projectId: IdSchema })

export const runTicketLabelsReadTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const { projectId } = ReadInput.parse(input)
  const member = await resolveActingMember(context)
  await projectFor(context, member, projectId)
  const labels = await listProjectLabels(context.prisma, projectId)
  recordProjectRead(context, member, projectId)
  return result(
    'ticket_labels_read',
    `projectId=${projectId}`,
    labels.length ? `Labels (${labels.length})\n${labels.map(labelLine).join('\n')}` : 'This project has no labels.',
  )
}

const CreateInput = z.object({
  projectId: IdSchema,
  name: z.string().trim().min(1).max(TASK_LABEL_NAME_MAX_CHARS),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'color must be #rrggbb').optional(),
})

export const runTicketLabelCreateTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = CreateInput.parse(input)
  const member = await resolveActingMember(context)
  await projectFor(context, member, args.projectId)
  await assertProjectWriteDestination(context, {
    organizationId: member.organizationId,
    projectId: args.projectId,
  })
  const project = { id: args.projectId, organizationId: member.organizationId }
  const created = await createProjectLabel(context.prisma, project, {
    name: args.name,
    ...(args.color ? { color: args.color } : {}),
    createdByUserId: member.userId,
  })
  if (isTaskLabelError(created)) {
    if (created.error === 'LABEL_NAME_TAKEN') {
      return result(
        'ticket_label_create',
        `projectId=${args.projectId} name="${args.name}"`,
        `A label with that name already exists; use it.\n${labelLine(created.existing)}`,
      )
    }
    throw new Error('Label not found.')
  }
  await publishProjectBoardUpdated(context.realtimeTransport, {
    organizationId: member.organizationId,
    projectId: args.projectId,
  })
  return result(
    'ticket_label_create',
    `projectId=${args.projectId} name="${args.name}"`,
    `Created label\n${labelLine(created)}`,
  )
}

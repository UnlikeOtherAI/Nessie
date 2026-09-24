import { ensureProjectDocumentsSpace, loadSpaceViewer } from '@nessie/knowledge'
import { resolveLiveEntitlements } from '@nessie/runtime'
import { ColumnCategorySchema } from '@nessie/schemas'
import {
  checkPolicy,
  createBoardColumn,
  isBoardMutationError,
  publishProjectBoardUpdated,
  updateBoardColumn,
} from '@nessie/team-admin'
import { z } from 'zod'

import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import type { ActingMember } from './access.js'
import { createWorkerKnowledgeProvider } from './knowledge-provider.js'
import { requireModifiableProject, resolveOperatorAwareMember } from './project-operator.js'
import { assertProjectWriteDestination, recordProjectRead, result } from './ticket-context.js'
import { formatBoardMarkdownLink } from './tool-output.js'

/**
 * The project-operator verbs that had no tool before
 * (`builtin-project-operator-tools.ts`): a board's columns, and a project's
 * document spaces. Each calls the function its route calls and takes the
 * route's gate — `requireProjectModifier` for a column, project membership and
 * `knowledge_space:create` for a space — as the person asking, on whichever
 * arm the call came through (`resolveOperatorAwareMember` re-checks the whole
 * operator arm on that face). What they write names a board or space its whole
 * project reads, so the run's consumed material must be the project's to read
 * (`assertProjectWriteDestination`), as it must for a board or a label.
 */

const Id = z.string().uuid()

const ColumnCreateInput = z.object({
  boardId: Id,
  category: ColumnCategorySchema,
  name: z.string().trim().min(1).max(80),
  position: z.number().int().nonnegative().optional(),
})

const ColumnUpdateInput = z.object({
  boardId: Id,
  category: ColumnCategorySchema.optional(),
  columnId: Id,
  name: z.string().trim().min(1).max(80).optional(),
  position: z.number().int().nonnegative().optional(),
})

const SpaceCreateInput = z.object({
  description: z.string().trim().min(1).max(1_000).optional(),
  kind: z.enum(['project_documents', 'space']),
  name: z.string().trim().min(1).max(200).optional(),
  projectId: Id.optional(),
})

/** The board, in a live project the person may change; refused in the route's words otherwise. */
const modifiableBoard = async (
  context: BuiltinToolRuntimeContext,
  member: ActingMember,
  boardId: string,
) => {
  const board = await context.prisma.board.findFirst({
    where: { id: boardId, organizationId: member.organizationId, project: { deletedAt: null } },
    select: { id: true, name: true, organizationId: true, projectId: true },
  })
  if (!board) throw new Error('Board not found. Read the project\'s boards with ticket_board_read.')
  await requireModifiableProject(context, member, board.projectId)
  await assertProjectWriteDestination(context, { organizationId: member.organizationId, projectId: board.projectId })
  return board
}

const describeColumn = (column: { category: string; id: string; name: string }): string =>
  `${column.name} (${column.category}, columnId=${column.id})`

export const runTicketBoardColumnCreateTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = ColumnCreateInput.parse(input)
  const { member } = await resolveOperatorAwareMember(context)
  const board = await modifiableBoard(context, member, args.boardId)
  const column = await createBoardColumn(context.prisma, board, {
    category: args.category,
    name: args.name,
    ...(args.position === undefined ? {} : { position: args.position }),
  })
  recordProjectRead(context, member, board.projectId)
  await publishProjectBoardUpdated(context.realtimeTransport, {
    organizationId: member.organizationId,
    projectId: board.projectId,
  })
  return result(
    'ticket_board_column_create',
    `boardId=${board.id} name="${args.name}"`,
    `Added column ${describeColumn(column)} to ${formatBoardMarkdownLink(board)}`,
  )
}

export const runTicketBoardColumnUpdateTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const { boardId, columnId, ...changes } = ColumnUpdateInput.parse(input)
  if (Object.keys(changes).length === 0) throw new Error('Name what changes: name, category or position.')
  const { member } = await resolveOperatorAwareMember(context)
  const board = await modifiableBoard(context, member, boardId)
  const updated = await updateBoardColumn(context.prisma, board.id, columnId, changes)
  if (isBoardMutationError(updated)) {
    throw new Error('Column not found on that board. Read its columns with ticket_board_read.')
  }
  recordProjectRead(context, member, board.projectId)
  await publishProjectBoardUpdated(context.realtimeTransport, {
    organizationId: member.organizationId,
    projectId: board.projectId,
  })
  return result(
    'ticket_board_column_update',
    `boardId=${board.id} columnId=${columnId}`,
    `Changed column ${describeColumn(updated)} on ${formatBoardMarkdownLink(board)}`
    + (changes.category ? '. Tickets placed in it by hand keep their status and leave the column.' : ''),
  )
}

/**
 * `POST /api/knowledge-base/spaces`, as the person asking: the project must be
 * one they belong to (the knowledge viewer's projects — an organisation role
 * alone does not reach it there either) and `knowledge_space:create` must
 * allow them. The Project Documents space goes through its own idempotent
 * provisioning, so asking twice answers with the same space.
 */
export const runKbSpaceCreateTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = SpaceCreateInput.parse(input)
  if (args.kind === 'space' && !args.name) throw new Error('A new space needs a name.')
  const { member, operatorProjectId } = await resolveOperatorAwareMember(context)
  const projectId = args.projectId ?? operatorProjectId
  if (!projectId) throw new Error('Name the projectId. Resolve it with project_list first.')

  const project = await context.prisma.project.findFirst({
    where: { deletedAt: null, id: projectId, organizationId: member.organizationId },
    select: { id: true, name: true },
  })
  const viewer = await loadSpaceViewer(context.prisma, member.organizationId, {
    actorId: member.userId,
    actorType: 'user',
  }, {
    liveEntitlements: await resolveLiveEntitlements(context.prisma, {
      organizationId: member.organizationId,
      uoaIdentity: context.actorContext.actionContext.uoaIdentity,
      userId: member.userId,
    }),
  })
  if (!project || !viewer.projectIds.has(project.id)) {
    throw new Error('Only a member of that project can give it a document space, and the person you are acting for is not one.')
  }
  const decision = await checkPolicy(context.prisma, {
    ...member.actorContext,
    // The route's question, not the tool call's: may this person create a space.
    actionContext: { ...member.actorContext.actionContext, toolId: undefined },
  }, 'knowledge_space', 'create')
  if (!decision.allowed) throw new Error(`Creating a document space is denied by policy: ${decision.reasonCode}`)
  await assertProjectWriteDestination(context, { organizationId: member.organizationId, projectId: project.id })

  if (args.kind === 'project_documents') {
    const ensured = await ensureProjectDocumentsSpace(context.prisma, {
      actorId: member.userId,
      organizationId: member.organizationId,
      projectId: project.id,
    })
    return result(
      'kb_space_create',
      `projectId=${project.id} kind=project_documents`,
      `${ensured.created ? 'Created' : 'Already there:'} Project Documents of project "${project.name}" `
      + `(spaceId=${ensured.spaceId}, visibility=project)`,
    )
  }
  const space = await createWorkerKnowledgeProvider(context).createSpace({
    createdBy: member.userId,
    ...(args.description ? { description: args.description } : {}),
    name: args.name!,
    organizationId: member.organizationId,
    projectId: project.id,
    visibility: 'project',
  })
  return result(
    'kb_space_create',
    `projectId=${project.id} kind=space name="${args.name}"`,
    `Created document space "${space.name}" in project "${project.name}" (spaceId=${space.id}, visibility=project)`,
  )
}

export const PROJECT_OPERATOR_TOOL_RUNNERS: Record<
  string,
  (context: BuiltinToolRuntimeContext, input: Record<string, unknown>) => Promise<ToolExecutionResult>
> = {
  kb_space_create: runKbSpaceCreateTool,
  ticket_board_column_create: runTicketBoardColumnCreateTool,
  ticket_board_column_update: runTicketBoardColumnUpdateTool,
}

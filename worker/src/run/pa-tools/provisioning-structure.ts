import { createNativeKnowledgeProvider, type KnowledgeSpaceRecord } from '@nessie/knowledge'
import { isAgentAccessibleToActor, isProjectAccessibleToUser, listBoards } from '@nessie/team-admin'
import { z } from 'zod'

import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import { buildVisibleChannelWhere, type ActingMember } from './access.js'
import { canReadPageVersions, recordPageVersionRead, resolveKnowledgeAccessViewers } from './knowledge.js'
import { recordKnowledgeSpaceRead } from './knowledge-basis.js'
import { recordChannelDirectoryRead, recordVisibleAgentRead } from './message-search-basis.js'
import { resolveOperatorAwareMember } from './project-operator.js'
import { PROJECT_OPERATOR_TOOL_RUNNERS } from './project-operator-tools.js'
import { runProjectCreateTool, runProjectListTool, runTeamCreateTool } from './team-structure.js'
import { recordProjectRead } from './ticket-context.js'
import {
  formatAgentMarkdownLink,
  formatBoardStructureLines,
  formatChannelMarkdownLink,
  formatProjectMarkdownLink,
  formatSection,
} from './tool-output.js'

/**
 * `project_structure_read`: what a project is made of, for the person setting
 * up work in it (docs/plans/2026-09-23-ticket-driven-agents/setup-and-ui.md,
 * "What the Designer needs").
 *
 * A ticket trigger needs a board, its start-work columns and a public channel
 * the agent is in, and a document trigger a space and a folder; without this
 * read the Designer guessed their ids. It is identity-delegated, like
 * `agent_read`: it acts as the person in the Designer's home DM, and every
 * part is read through that person's own access, never wider —
 *
 * - the project itself through `isProjectAccessibleToUser`, the gate
 *   `ticket_board_read` and the board routes use;
 * - the channels through `buildVisibleChannelWhere` (public ones, and the ones
 *   they are in), live and ordinary only;
 * - the document spaces through the knowledge viewer `kb_list` reads with,
 *   and each top-level folder through the same version gate as `kb_list`'s
 *   page tree.
 *
 * Each name that reaches the run stamps its scope exactly as the read it
 * mirrors stamps it.
 */

const MAX_CHANNELS = 50
const MAX_SPACES = 20
const MAX_FOLDERS = 20

const InputSchema = z.object({
  agentId: z.string().uuid().optional(),
  projectId: z.string().uuid(),
})

const readAgent = async (context: BuiltinToolRuntimeContext, member: ActingMember, agentId: string | undefined) => {
  if (!agentId) return null
  if (!(await isAgentAccessibleToActor(context.prisma, member.actorContext, agentId))) {
    throw new Error('Agent not found. Resolve it with agent_list.')
  }
  const agent = await context.prisma.agent.findUniqueOrThrow({
    where: { id: agentId },
    select: { id: true, name: true, visibility: true },
  })
  recordVisibleAgentRead(context, [agent])
  return agent
}

const channelLines = async (
  context: BuiltinToolRuntimeContext,
  member: ActingMember,
  projectId: string,
  agent: { id: string; name: string } | null,
): Promise<string[]> => {
  const channels = await context.prisma.channel.findMany({
    where: {
      AND: [
        buildVisibleChannelWhere(member.organizationId, member.userId),
        { archivedAt: null, dmKey: null, projectId, systemChannelType: null, type: 'standard' },
      ],
    },
    orderBy: { label: 'asc' },
    select: { id: true, label: true, topic: true, type: true, visibility: true },
    take: MAX_CHANNELS,
  })
  recordChannelDirectoryRead(context, channels)
  const bound = agent
    ? new Set((await context.prisma.agentBinding.findMany({
        where: { agentId: agent.id, channelId: { in: channels.map((channel) => channel.id) } },
        select: { channelId: true },
      })).map((binding) => binding.channelId))
    : null
  // The id beside the link, as boards and columns carry theirs: a ticket
  // trigger's `targetChannelId` is that id, never something to dig from a URL.
  return channels.map((channel) =>
    `- ${formatChannelMarkdownLink(channel)} (channelId=${channel.id}) | ${channel.visibility}`
    + (agent && bound ? ` | ${agent.name} ${bound.has(channel.id) ? 'is in it' : 'is not in it'}` : ''))
}

const spaceLines = async (
  context: BuiltinToolRuntimeContext,
  member: ActingMember,
  projectId: string,
): Promise<string[]> => {
  const provider = createNativeKnowledgeProvider(context.prisma)
  const { disclosureViewer, viewer } = await resolveKnowledgeAccessViewers(context)
  const spaces = (await provider.listSpaces({
    includePersonal: false,
    limit: MAX_SPACES,
    organizationId: member.organizationId,
    projectId,
    viewer,
  })).data
  return (await Promise.all(spaces.map(async (space: KnowledgeSpaceRecord) => {
    const pages = await provider.listPages({
      disclosureViewer,
      organizationId: member.organizationId,
      spaceId: space.id,
    })
    const roots = pages.filter((page) => page.kind === 'folder' && !page.parentPageId).slice(0, MAX_FOLDERS)
    const folders = (await Promise.all(roots.map(async (page) =>
      (await canReadPageVersions(context, page, disclosureViewer)) ? page : null)))
      .filter((page) => page !== null)
    // Listing a space names it without reading it, as kb_list's catalogue
    // does; a folder's title is read out of its tree, and stamps like one.
    if (folders.length > 0) recordKnowledgeSpaceRead(context, [space])
    for (const folder of folders) recordPageVersionRead(context, folder)
    return `- ${space.name} (spaceId=${space.id}, visibility=${space.visibility}) | top-level folders: `
      + (folders.length > 0
        ? folders.map((folder) => `${folder.title} (pageId=${folder.id})`).join(', ')
        : 'none')
  })))
}

export const runProjectStructureReadTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = InputSchema.parse(input)
  // The Designer's identity arm, or the project operator's: either way the
  // person asking, read through their own access and never wider.
  const { member } = await resolveOperatorAwareMember(context)
  const project = await context.prisma.project.findFirst({
    where: { deletedAt: null, id: args.projectId, organizationId: member.organizationId },
    select: { id: true, name: true },
  })
  if (!project || !(await isProjectAccessibleToUser(context.prisma, member, project.id))) {
    throw new Error('Project not found, or you are not in it. Resolve it with project_list.')
  }
  const agent = await readAgent(context, member, args.agentId)
  const boards = await listBoards(context.prisma, { id: project.id, organizationId: member.organizationId })
  recordProjectRead(context, member, project.id)
  const boardLines = boards.flatMap((board) => formatBoardStructureLines({ ...board, projectId: project.id }))
  const channels = await channelLines(context, member, project.id, agent)
  const spaces = await spaceLines(context, member, project.id)
  return {
    inputSummary: `projectId=${project.id}${agent ? ` agentId=${agent.id}` : ''}`,
    outputPreview: [
      `Project ${formatProjectMarkdownLink(project)}`
      + (agent ? `, as seen for ${formatAgentMarkdownLink(agent)}` : ''),
      formatSection(`Boards (${boards.length})`, boardLines) || 'Boards: none.',
      formatSection(`Channels you can read (${channels.length})`, channels)
        || 'Channels you can read: none in this project.',
      formatSection(`Document spaces you can read (${spaces.length})`, spaces)
        || 'Document spaces you can read: none in this project.',
    ].join('\n\n'),
    toolName: 'project_structure_read',
  }
}

type ProjectStructureToolRunner = (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
) => Promise<ToolExecutionResult>

/**
 * The projects, the teams inside them and what a project is made of —
 * with the operator verbs that set its boards' columns and document spaces
 * up — dispatched by id. One table rather than a `case` each in the main
 * dispatcher, which is at its line cap.
 */
export const PROJECT_STRUCTURE_TOOL_RUNNERS: Readonly<Record<string, ProjectStructureToolRunner>> = {
  project_create: runProjectCreateTool,
  project_list: runProjectListTool,
  project_structure_read: runProjectStructureReadTool,
  team_create: runTeamCreateTool,
  ...PROJECT_OPERATOR_TOOL_RUNNERS,
}

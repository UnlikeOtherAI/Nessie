import {
  createProjectForUser,
  createTeamForUser,
  listProjectsForUser,
  listTeamsForOrganization,
  ProjectValidationError,
  UoaBoundOrganizationError,
} from '@nessie/team-admin'
import { z } from 'zod'

import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import { requireOwnerMember, resolveActingMember } from './access.js'
import { formatProjectMarkdownLink, formatSection } from './tool-output.js'

/**
 * Projects and the teams inside them — the containers a channel needs.
 *
 * `project_create` mirrors `POST /api/projects`, which any active member may
 * call: `createProjectForUser` itself refuses a team the person is not in
 * (unless they are an organisation owner or admin). `team_create` mirrors
 * `POST /api/teams`, which is `requireOwner`, so it is an organisation-owner
 * action refused in words (naming who can do it) for anybody else rather than
 * hidden. Role comes from the live `OrganizationMember` row at call time, never
 * the run's enqueue-time snapshot. `project_list` mirrors `GET /api/projects`,
 * which any active member may call.
 *
 * Each calls the very same `@nessie/team-admin` function its route calls,
 * so the board columns a project starts with and its single owner membership row
 * cannot drift between clicking and asking.
 *
 * A project created here has exactly ONE member: the person who asked for it.
 * Neither write announces itself to the organisation or adds anybody else.
 */

/**
 * A team as these tools name it. A team has no admin page of its own, so it
 * cannot be a link; its teamId, which `channel_create` takes, stays beside the
 * name — the one raw id these outputs still print.
 */
const formatTeamRef = (team: { id: string; name: string }): string =>
  `"${team.name}" (teamId=${team.id})`

const ProjectListInputSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1, 'query cannot be blank — omit it to list every project you can see.')
    .optional(),
})

/**
 * Provenance for a project-directory read.
 *
 * An organisation OWNER or ADMIN reaches every project by role, so for them a
 * project name is organisation-level material the destination already implies —
 * stamping `project:<id>` would compute a basis the requesting person does not
 * satisfy (viewer project scopes come from `ProjectMember` rows alone) and
 * withhold the answer from the only reader of their own DM. That is exactly the
 * reasoning `recordVisibleAgentRead` applies to team-visible agents.
 *
 * Anybody else reached these projects through their own membership, so the
 * scope is stamped and they satisfy it.
 *
 * Team names are deliberately not stamped: `GET /api/teams` narrows teams by
 * organisation only, so a team's existence and name are organisation-level
 * material for every member.
 */
const recordProjectDirectoryRead = (
  context: Pick<BuiltinToolRuntimeContext, 'consumedSources'>,
  viewer: { isOrganizationAdmin: boolean },
  projectIds: readonly string[],
): void => {
  const sink = context.consumedSources
  if (!sink || viewer.isOrganizationAdmin) return
  for (const projectId of projectIds) {
    sink.add({ scopeId: projectId, scopeType: 'project' })
  }
}

export const runProjectListTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = ProjectListInputSchema.parse(input)
  const member = await resolveActingMember(context)

  const projects = await listProjectsForUser(context.prisma, {
    isOrganizationAdmin: member.isOrganizationAdmin,
    organizationId: member.organizationId,
    userId: member.userId,
  })
  // Teams are narrowed to the projects this person can already read, which is
  // strictly narrower than `GET /api/teams`'s own organisation scope.
  const teams = await listTeamsForOrganization(context.prisma, {
    organizationId: member.organizationId,
    projectIds: projects.map((project) => project.id),
  })

  recordProjectDirectoryRead(context, member, projects.map((project) => project.id))

  // Narrowing is a filter over an already-authorized list, never a second
  // query: a project matches on its own name or on any of its teams' names.
  const needle = args.query?.toLowerCase()
  const matches = projects.filter((project) => {
    if (!needle) return true
    if (project.name.toLowerCase().includes(needle)) return true
    return teams.some(
      (team) =>
        (team.projectIds ?? []).includes(project.id) && team.name.toLowerCase().includes(needle),
    )
  })

  // Each project is a link, as project_create's is: its last segment is the
  // projectId a later call takes. A team has no page to link, so it keeps
  // beside its name the teamId channel_create takes.
  const lines = matches.map((project) => {
    const projectTeams = teams.filter((team) => (team.projectIds ?? []).includes(project.id))
    const teamText = projectTeams.length === 0
      ? 'no teams yet — a channel needs one'
      : projectTeams.map(formatTeamRef).join(', ')
    return `- ${formatProjectMarkdownLink(project)} | teams: ${teamText}`
  })

  const empty = needle
    ? `No project you can see matches "${args.query}".`
    : 'No projects are visible to you.'

  return {
    inputSummary: needle ? `query="${args.query}"` : 'all',
    outputPreview: formatSection(`Projects (${lines.length})`, lines) || empty,
    toolName: 'project_list',
  }
}

const ProjectCreateInputSchema = z.object({
  name: z.string().min(1, 'name is required.'),
  teamId: z.string().uuid(),
})

export const runProjectCreateTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = ProjectCreateInputSchema.parse(input)
  const member = await resolveActingMember(context)

  let project
  try {
    project = await createProjectForUser(context.prisma, {
      name: args.name,
      organizationId: member.organizationId,
      teamId: args.teamId,
      userId: member.userId,
    })
  } catch (error) {
    // The route turns this into a 400; the message is already written for a
    // person, so it travels to the model as it is.
    if (error instanceof ProjectValidationError) throw new Error(error.message)
    throw error
  }

  // Data a person can be handed as it is, like agent_create's: a raw
  // `projectId=<uuid>` is copied into the reply as it stands. The id a later
  // call takes (channel_create, team_create) is the link's last segment. The
  // team stays in the result too, with the teamId channel_create takes, so
  // that call never depends on the model still holding this call's arguments.
  // Not creating a second channel unasked is a rule in the tool's description
  // and the Designer's prompt, not an instruction inside its result.
  const team = await context.prisma.team.findUnique({
    where: { id: args.teamId },
    select: { id: true, name: true },
  })
  return {
    inputSummary: `name="${args.name}" teamId=${args.teamId}`,
    outputPreview: [
      `Created project ${formatProjectMarkdownLink(project)}`
      + ` in team ${formatTeamRef(team ?? { id: args.teamId, name: 'team' })}`,
      'You are its only member — nobody else was added. Anyone you add later has the same rights in it as you.',
      'It already has its own #general channel.',
    ].join('\n'),
    toolName: 'project_create',
  }
}

const TeamCreateInputSchema = z.object({
  name: z.string().min(1, 'name is required.'),
  projectId: z.string().uuid(),
})

export const runTeamCreateTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = TeamCreateInputSchema.parse(input)
  const member = await resolveActingMember(context)

  requireOwnerMember(member, 'create a team')

  let team
  try {
    team = await createTeamForUser(context.prisma, {
      name: args.name,
      organizationId: member.organizationId,
      projectId: args.projectId,
      userId: member.userId,
    })
  } catch (error) {
    if (error instanceof ProjectValidationError) throw new Error(error.message)
    // The route's own 403: inside a UOA-bound organisation a team is a UOA
    // team, so it is created upstream and never here.
    if (error instanceof UoaBoundOrganizationError) throw new Error(error.message)
    throw error
  }
  // The route's own 404: a project of another organisation is indistinguishable
  // from one that does not exist.
  if (!team) {
    throw new Error('Project not found. Resolve it with project_list first.')
  }

  // The project as a link, the team by name with the teamId channel_create
  // takes; what to do with it is the tool description's to say. The project's
  // name is directory material, stamped as project_list stamps it.
  const project = await context.prisma.project.findUnique({
    where: { id: team.projectId },
    select: { id: true, name: true },
  })
  recordProjectDirectoryRead(context, member, [team.projectId])
  return {
    inputSummary: `name="${args.name}" projectId=${args.projectId}`,
    outputPreview: [
      `Created team ${formatTeamRef(team)} in `
      + formatProjectMarkdownLink(project ?? { id: team.projectId, name: 'project' }),
      'You are its only member and its owner — nobody else was added.',
    ].join('\n'),
    toolName: 'team_create',
  }
}

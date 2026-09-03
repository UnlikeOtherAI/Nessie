import {
  createProjectForUser,
  createTeamForUser,
  listProjectsForUser,
  listTeamsForOrganization,
  ProjectValidationError,
} from '@nessie/team-admin'
import { z } from 'zod'

import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import { requireOwnerMember, resolveActingMember } from './access.js'
import { formatSection } from './tool-output.js'

/**
 * Projects and the teams inside them — the containers a channel needs.
 *
 * `project_create` mirrors `POST /api/projects` and `team_create` mirrors
 * `POST /api/teams`: both routes are `requireOwner`, so both tools are
 * organisation-owner actions, refused in words (naming who can do it) for
 * anybody else rather than hidden. Role comes from the live
 * `OrganizationMember` row at call time, never the run's enqueue-time snapshot.
 * `project_list` mirrors `GET /api/projects`, which any active member may call.
 *
 * Each calls the very same `@nessie/team-admin` function its route calls,
 * so the board columns a project starts with and its single owner membership row
 * cannot drift between clicking and asking.
 *
 * A project created here has exactly ONE member: the person who asked for it.
 * Neither write announces itself to the organisation or adds anybody else.
 */

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
 * An organisation OWNER reaches every project by role, so for them a project
 * name is organisation-level material the destination already implies —
 * stamping `project:<id>` would compute a basis the requesting owner does not
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
  viewer: { isOwner: boolean },
  projectIds: readonly string[],
): void => {
  const sink = context.consumedSources
  if (!sink || viewer.isOwner) return
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
    isOwner: member.isOwner,
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
        team.projectId === project.id && team.name.toLowerCase().includes(needle),
    )
  })

  const lines = matches.map((project) => {
    const projectTeams = teams.filter((team) => team.projectId === project.id)
    const teamText = projectTeams.length === 0
      ? 'no teams yet — a channel needs one'
      : projectTeams
        .map((team) => `"${team.name}" (teamId=${team.id})`)
        .join(', ')
    return `- "${project.name}" | projectId=${project.id} | teams: ${teamText}`
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
})

export const runProjectCreateTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = ProjectCreateInputSchema.parse(input)
  const member = await resolveActingMember(context)

  requireOwnerMember(member, 'create a project')

  let project
  try {
    project = await createProjectForUser(context.prisma, {
      name: args.name,
      organizationId: member.organizationId,
      userId: member.userId,
    })
  } catch (error) {
    // The route turns this into a 400; the message is already written for a
    // person, so it travels to the model as it is.
    if (error instanceof ProjectValidationError) throw new Error(error.message)
    throw error
  }

  return {
    inputSummary: `name="${args.name}"`,
    outputPreview: [
      `Created project "${project.name}"`,
      `projectId=${project.id}`,
      'You are its only member and its owner — nobody else was added.',
      'A project holds no channels until it has a team: create one with '
      + 'team_create, then a channel in that team with channel_create.',
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
    throw error
  }
  // The route's own 404: a project of another organisation is indistinguishable
  // from one that does not exist.
  if (!team) {
    throw new Error('Project not found. Resolve it with project_list first.')
  }

  return {
    inputSummary: `name="${args.name}" projectId=${args.projectId}`,
    outputPreview: [
      `Created team "${team.name}" in projectId=${team.projectId}`,
      `teamId=${team.id}`,
      'You are its only member and its owner — nobody else was added.',
      'Pass this teamId to channel_create to put a channel in this project.',
    ].join('\n'),
    toolName: 'team_create',
  }
}

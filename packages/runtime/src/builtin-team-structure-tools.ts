import type { BuiltinToolDefinition } from './builtin-tools-types.js'

/**
 * Team structure: the projects and teams a channel lives inside.
 *
 * A channel is attached to a team, and a team to a project, so "give this agent
 * its own place to work" can need all three. `channel_create` already existed;
 * these two are the containers above it, and `project_list` is the read that
 * turns "the Marketing project" into the id they take — the same rule that
 * gave `agent_bind_channel` its `agent_list`.
 *
 * Any organisation member may create a project, in a team they are a member of
 * (`createProjectForUser`; an organisation owner or admin may place one in any
 * team). Creating a team stays an organisation-owner action (`POST /api/teams`
 * is `requireOwner`). Like the connector tools, both stay VISIBLE to everybody
 * and refuse in words naming who can do it, rather than letting an agent claim
 * it has no such capability. `project_list` mirrors `GET /api/projects`, which
 * any member may call.
 *
 * They are `personalAssistantOnly` (not `identityDelegatedOnly`): standing up a
 * project is provisioning, the same tier as `channel_create`, so the Personal
 * Assistant reaches them too. `identityDelegatedOnly` is the narrower marker
 * for the *design* verbs that belong to the Agent Designer alone.
 */
export const TEAM_STRUCTURE_TOOL_DEFINITIONS: BuiltinToolDefinition[] = [
  {
    id: 'project_list',
    category: 'projects',
    summary: 'List the projects you can reach and the teams inside them.',
    label: 'List Projects',
    personalAssistantOnly: true,
    projectOperator: true,
    description:
      'List the projects the person asking you can reach, each with the teams inside it. This is '
      + 'how a project or team NAME becomes the projectId team_create needs and '
      + 'the teamId channel_create needs — do not ask the user for an id, and do '
      + 'not invent one. Each row links the project as [Name](/projects/<projectId>) '
      + '— the last path segment of that link is the projectId — and names its '
      + 'teams as "Name" (teamId=<teamId>). An organisation owner or admin sees '
      + 'every project; anybody else sees the projects they belong to.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Optional: narrow the list to projects or teams whose name matches.',
        },
      },
    },
    safe: true,
  },
  {
    // The read a ticket trigger's config is built from: without it the
    // Designer guesses board, column and channel ids. Identity-delegated like
    // agent_read — it acts as the person in the Designer's home DM and answers
    // only what that person can see.
    id: 'project_structure_read',
    category: 'projects',
    summary: 'Read a project’s boards and columns, channels and document spaces.',
    label: 'Read Project Structure',
    personalAssistantOnly: true,
    identityDelegatedOnly: true,
    projectOperator: true,
    description:
      'Read what a project is made of, as the person asking you sees it, before you set up work in it: '
      + 'its boards with every column and its '
      + 'category (todo, in_progress, review, done), the channels in it you can read with their visibility, '
      + 'and its document spaces with their top-level folders. Pass agentId to see which channels that '
      + 'agent is already in. A ticket_changed trigger needs a board, its start-work columns and a public '
      + 'channel the agent is in; take them from here rather than guessing. Only what you can see is listed. '
      + 'Resolve the projectId with project_list.',
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'The project, from project_list.' },
        agentId: {
          type: 'string',
          description: 'Optional: the agent whose channel placements to show, from agent_list.',
        },
      },
      required: ['projectId'],
    },
    safe: true,
  },
  {
    id: 'project_create',
    category: 'projects',
    summary: 'Create a project, owned by the user.',
    label: 'Create Project',
    personalAssistantOnly: true,
    projectOperator: true,
    description:
      'Create a new project in the current organisation, acting as the person '
      + 'asking you with exactly their rights. They become its '
      + 'only member; nobody else is added. Any member may create one in a team '
      + 'they belong to. Resolve an existing team with project_list and pass its '
      + 'teamId. The project starts with its own #general channel; do not create '
      + 'another channel for it unless the person asked for one. It also starts with '
      + 'one board, whose columns the result lists by id: rename and recategorise '
      + 'them with ticket_board_column_update, and add any with '
      + 'ticket_board_column_create, rather than making a second board. The result links '
      + 'the new project as [Name](/projects/<projectId>): the last path segment '
      + 'of that link is the projectId channel_create and team_create take. It '
      + 'names the team the project is in as "Name" (teamId=<teamId>), the '
      + 'teamId channel_create takes with it.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'The project name, e.g. "Marketing".',
        },
        teamId: {
          type: 'string',
          description: 'The existing team the project belongs to, from project_list.',
        },
      },
      required: ['name', 'teamId'],
    },
    safe: false,
  },
  {
    id: 'team_create',
    category: 'projects',
    summary: 'Create a team inside a project, owned by the user.',
    label: 'Create Team',
    personalAssistantOnly: true,
    projectOperator: true,
    description:
      'Create a team inside a project, acting as the person asking you with '
      + 'exactly their rights. They become its only member and its '
      + 'owner; nobody else is added. Organisation owners only. Channels attach '
      + 'to a team, so this is what makes a project able to hold one — pass the '
      + 'returned teamId to channel_create. Resolve projectId with project_list, '
      + 'or read it from the /projects/… link project_create returned (its last '
      + 'path segment). The result names the team as "Name" (teamId=<teamId>) '
      + 'and links the project it is in.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'The team name, e.g. "Campaigns".',
        },
        projectId: {
          type: 'string',
          description: 'The project this team belongs to.',
        },
      },
      required: ['name', 'projectId'],
    },
    safe: false,
  },
]

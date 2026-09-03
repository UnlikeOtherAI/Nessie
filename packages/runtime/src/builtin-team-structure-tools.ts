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
 * `POST /api/projects` and `POST /api/teams` are both `requireOwner`, so both
 * writes are organisation-owner actions. Like the connector tools, they stay
 * VISIBLE to everybody and refuse in words naming who can do it, rather than
 * letting an agent claim it has no such capability. `project_list` mirrors
 * `GET /api/projects`, which any member may call.
 *
 * They are `personalAssistantOnly` (not `identityDelegatedOnly`): standing up a
 * project is provisioning, the same tier as `channel_create`, so the Personal
 * Assistant reaches them too. `identityDelegatedOnly` is the narrower marker
 * for the *design* verbs that belong to the Agent Designer alone.
 */
export const TEAM_STRUCTURE_TOOL_DEFINITIONS: BuiltinToolDefinition[] = [
  {
    id: 'project_list',
    category: 'team',
    summary: 'List the projects you can reach and the teams inside them.',
    label: 'List Projects',
    personalAssistantOnly: true,
    description:
      'List the projects you can reach, each with the teams inside it. This is '
      + 'how a project or team NAME becomes the projectId team_create needs and '
      + 'the teamId channel_create needs — do not ask the user for an id, and do '
      + 'not invent one. An organisation owner sees every project; anybody else '
      + 'sees the projects they belong to.',
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
    id: 'project_create',
    category: 'team',
    summary: 'Create a project, owned by the user.',
    label: 'Create Project',
    personalAssistantOnly: true,
    description:
      'Create a new project in the current organisation. The user becomes its '
      + 'only member and its owner; nobody else is added. Organisation owners '
      + 'only. A project holds no channels until it has a team, so follow this '
      + 'with team_create, then channel_create for the team it returns.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'The project name, e.g. "Marketing".',
        },
      },
      required: ['name'],
    },
    safe: false,
  },
  {
    id: 'team_create',
    category: 'team',
    summary: 'Create a team inside a project, owned by the user.',
    label: 'Create Team',
    personalAssistantOnly: true,
    description:
      'Create a team inside a project. The user becomes its only member and its '
      + 'owner; nobody else is added. Organisation owners only. Channels attach '
      + 'to a team, so this is what makes a project able to hold one — pass the '
      + 'returned teamId to channel_create. Resolve projectId with project_list.',
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

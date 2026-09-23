import assert from 'node:assert/strict'
import test from 'node:test'

import { BUILTIN_TOOL_DEFINITIONS } from '../src/index.js'

/**
 * The Designer's tools answer with markdown links, not `key=<uuid>` pairs, so
 * a later call reads its id out of a link. Each description says which link:
 * an agent's, a channel's, a project's or a trigger's — and a trigger's
 * `/agents/triggers/<id>` is never read as an agent's `/agents/<id>`.
 */

const description = (toolId: string): string => {
  const tool = BUILTIN_TOOL_DEFINITIONS.find(({ id }) => id === toolId)
  assert.ok(tool, `expected ${toolId} among the builtin tools`)
  return tool.description.replace(/\s+/g, ' ')
}

const says = (toolId: string, sentence: string): void => {
  assert.ok(description(toolId).includes(sentence), `${toolId} should say: ${sentence}`)
}

test('agent_list keeps the agent link and the channel link apart', () => {
  says('agent_list', 'The last path segment of the agent\'s link is the agentId that agent_read, '
    + 'agent_update, agent_bind_channel and agent_trigger_create take.')
  says('agent_list', 'The last path segment of a channel\'s link is the channelId that '
    + 'agent_bind_channel takes, and agent_trigger_create\'s targetChannelId; never pass one as the other.')
})

test('a trigger link is never an agent link', () => {
  says('agent_trigger_create', '/agents/triggers/… link, which is never an agent\'s: an agentId is only '
    + 'ever read from an /agents/<agentId> link')
})

test('channel_create and project_list say where the next id is read from', () => {
  says('channel_create', 'the last path segment of that link is the channelId agent_bind_channel takes')
  says('project_list', 'Each row links the project as [Name](/projects/<projectId>)')
  // A team has no page, so its id is data beside its name.
  says('project_create', '"Name" (teamId=<teamId>), the teamId channel_create takes with it')
})

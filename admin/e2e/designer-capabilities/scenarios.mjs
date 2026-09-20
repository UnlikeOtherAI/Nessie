export const GRANTED_ANSWER = 'CTO now has browser access and speaks with the Puck voice.'
export const REVOKED_ANSWER = 'I removed CTO browser access. Its voice remains Puck.'

const toolTurn = (toolName, args, index) => ({
  toolCalls: [{ toolName, arguments: args, toolCallId: `designer-evaluation-${index}` }],
  usage: { inputTokens: 100, outputTokens: 30 },
})

export const buildDesignerScenarios = (parseScenario, { scope, browserTool }) => ({
  grant: parseScenario({
    name: 'designer-private-grant-and-output-recovery',
    turns: [
      toolTurn('tool_spec', {
        names: ['agent_tool_access_inspect', 'agent_tool_access_set', 'agent_update'],
      }, 0),
      toolTurn('agent_tool_access_inspect', { agentId: scope.agentId }, 1),
      toolTurn('agent_tool_access_set', {
        agentId: scope.agentId, toolRegistryEntryId: browserTool.id, enabled: true,
      }, 2),
      toolTurn('agent_update', { agentId: scope.agentId, voiceName: 'Puck' }, 3),
      {
        finishReason: 'length',
        reasoning: 'The changes are complete; prepare a short account of what changed.',
        stream: { chunkSize: 12 },
        text: '',
        usage: { inputTokens: 100, outputTokens: 2_048 },
      },
      { text: GRANTED_ANSWER, usage: { inputTokens: 100, outputTokens: 20 } },
    ],
    utility: { text: '{}' },
  }),
  revoke: parseScenario({
    name: 'designer-private-revoke',
    turns: [
      toolTurn('tool_spec', { names: ['agent_tool_access_set'] }, 'revoke-0'),
      toolTurn('agent_tool_access_set', {
        agentId: scope.agentId, toolRegistryEntryId: browserTool.id, enabled: false,
      }, 'revoke-1'),
      { text: REVOKED_ANSWER, usage: { inputTokens: 100, outputTokens: 20 } },
    ],
    utility: { text: '{}' },
  }),
})

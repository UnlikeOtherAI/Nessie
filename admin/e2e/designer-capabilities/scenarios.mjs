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
      {
        finishReason: 'length',
        reasoning: 'I need to inspect the agent and carry out the requested access and voice changes.',
        stream: { chunkSize: 12 },
        text: '',
        usage: { inputTokens: 100, outputTokens: 2_048 },
      },
      toolTurn('tool_spec', {
        names: ['account_connections_list', 'agent_tool_access_inspect', 'agent_tool_access_set', 'agent_update'],
      }, 0),
      toolTurn('account_connections_list', {}, 'accounts'),
      toolTurn('agent_tool_access_inspect', { agentId: scope.agentId }, 1),
      toolTurn('agent_tool_access_set', {
        agentId: scope.agentId, toolRegistryEntryId: browserTool.id, enabled: true,
      }, 2),
      toolTurn('agent_update', { agentId: scope.agentId, voiceName: 'Puck' }, 3),
      { text: GRANTED_ANSWER, usage: { inputTokens: 100, outputTokens: 20 } },
    ],
    utility: { text: '{}' },
  }),
  accounts: parseScenario({
    name: 'personal-assistant-connected-accounts',
    turns: [
      toolTurn('tool_spec', { names: ['account_connections_list'] }, 'pa-spec'),
      toolTurn('account_connections_list', {}, 'pa-accounts'),
      { text: 'Your team browser account and Kimi plan are saved. Shall I ask Agent Designer to arrange access?' },
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

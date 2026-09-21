const followUp = {
  type: 'object',
  properties: {
    agentId: { type: 'string', description: 'An agent currently bound to this channel.' },
    principalUserId: { type: 'string', description: 'Exact PA presence owner, when applicable.' },
    instructions: { type: 'string', description: 'Work this agent should perform when the option is selected.' },
  },
  required: ['agentId', 'instructions'],
  additionalProperties: false,
}

/** Model-facing description of the policy, validated by ChannelDecisionPolicySchema on write. */
export const channelDecisionPolicyParameters = {
  type: 'object',
  properties: {
    version: { type: 'integer', enum: [1] },
    enabled: { type: 'boolean' },
    instructions: { type: 'string', description: 'How agents should participate in this channel.' },
    minimumProbability: { type: 'number', minimum: 0, maximum: 1 },
    reactions: {
      type: 'array', maxItems: 16,
      items: {
        type: 'object',
        properties: { emoji: { type: 'string' }, description: { type: 'string' } },
        required: ['emoji', 'description'], additionalProperties: false,
      },
    },
    questions: {
      type: 'array', maxItems: 8,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Unique stable question key.' },
          instructions: { type: 'string', description: 'One clear question about the message and conversation.' },
          options: {
            type: 'array', minItems: 2, maxItems: 16,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'A unique option key; enums may have more than two options.' },
                description: { type: 'string', description: 'When this option is the right decision.' },
                followUp,
              },
              required: ['id', 'description'], additionalProperties: false,
            },
          },
        },
        required: ['id', 'instructions', 'options'], additionalProperties: false,
      },
    },
  },
  required: ['version', 'enabled', 'instructions', 'minimumProbability', 'reactions', 'questions'],
  additionalProperties: false,
}

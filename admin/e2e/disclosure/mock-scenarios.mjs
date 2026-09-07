export const createSourceScenario = (parseScenario, groupId, summary) => parseScenario({
  name: 'disclosure-private-withheld',
  defaults: { latencyMs: 5, model: 'mock-model' },
  turns: [
    {
      reasoning: 'The person explicitly names one team destination and authorizes this exact update.',
      stream: { chunkDelayMs: 5, chunkSize: 12 },
      text: '',
      toolCalls: [{
        arguments: { content: summary, channelId: groupId },
        toolCallId: 'mock-disclosure-send-1',
        toolName: 'send_message',
      }],
      usage: { inputTokens: 101, outputTokens: 21 },
    },
    {
      text: 'Držím ten update omezený, dokud ho výslovně neschválíš.',
      usage: { inputTokens: 133, outputTokens: 12 },
    },
  ],
  utility: { text: '{}' },
})

export const createReaderScenario = (parseScenario) => parseScenario({
  name: 'disclosure-unauthorized-reader',
  defaults: { latencyMs: 5, model: 'mock-model' },
  turns: [
    {
      text: '',
      toolCalls: [{
        arguments: { query: 'Kestrel' },
        toolCallId: 'mock-disclosure-search-0',
        toolName: 'message_search',
      }],
      usage: { inputTokens: 101, outputTokens: 18 },
    },
    {
      reasoning: 'Search only the channels visible to the person who made this public request.',
      text: '',
      toolCalls: [{
        arguments: { query: 'Kestrel' },
        toolCallId: 'mock-disclosure-search-1',
        toolName: 'message_search',
      }],
      usage: { inputTokens: 133, outputTokens: 18 },
    },
    {
      text: 'Nemůžu sdílet obsah soukromého chatu.',
      usage: { inputTokens: 176, outputTokens: 18 },
    },
  ],
  utility: { text: '{}' },
})

export const createReplyRevisionScenario = (parseScenario, { content, messageId }) => parseScenario({
  name: 'disclosure-approved-reply-revision',
  defaults: { latencyMs: 5, model: 'mock-model' },
  turns: [
    // The revision is a second run in B's private thread, whose first run
    // already contributed one assistant reply to the model transcript.
    { text: '', usage: { inputTokens: 101, outputTokens: 0 } },
    {
      text: '',
      toolCalls: [{
        arguments: { content, messageId },
        toolCallId: 'mock-disclosure-edit-1',
        toolName: 'message_edit',
      }],
      usage: { inputTokens: 101, outputTokens: 21 },
    },
    {
      text: 'Upravil jsem citlivý update; zůstává omezený, dokud ho znovu neschválíš.',
      usage: { inputTokens: 176, outputTokens: 12 },
    },
  ],
  utility: { text: '{}' },
})

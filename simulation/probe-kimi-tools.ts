import { createInferenceService } from '../packages/runtime/dist/inference/index.js'
import type {
  InferenceRequest,
  ProviderMessage,
  ToolSchemaDescriptor,
} from '../packages/runtime/dist/inference/index.js'

const apiKey = process.env.KIMI_API_KEY
if (!apiKey) {
  console.error('KIMI_API_KEY not set')
  process.exit(1)
}

const service = createInferenceService({
  apiKey,
  baseUrl: process.env.KIMI_BASE_URL ?? 'https://api.kimi.com/coding',
  modelName: process.env.SIM_BRAIN_KIMI_MODEL ?? 'kimi-for-coding',
  provider: 'kimi',
})

const tools: ToolSchemaDescriptor[] = [
  {
    toolName: 'get_weather',
    description: 'Returns current weather for a city. Use this whenever a weather question comes up.',
    inputSchema: {
      type: 'object',
      properties: { location: { type: 'string' } },
      required: ['location'],
    },
  },
]

const round = async (messages: ProviderMessage[], label: string): Promise<InferenceRequest['messages']> => {
  const result = await service.run({
    maxOutputTokens: 400,
    messages,
    temperature: 0.2,
    tools,
  })
  console.log(`\n=== ${label} ===`)
  console.log('finishReason:', result.finishReason)
  console.log('outputText:', JSON.stringify(result.outputText))
  console.log('toolCalls:', JSON.stringify(result.toolCalls, null, 2))
  if (result.toolCalls.length > 0) {
    const next: ProviderMessage[] = [
      ...messages,
      { role: 'assistant', content: result.outputText, toolCalls: result.toolCalls },
    ]
    for (const call of result.toolCalls) {
      const location = String((call.arguments as { location?: unknown }).location ?? 'unknown')
      next.push({
        role: 'tool',
        content: JSON.stringify({ location, tempC: 21, condition: 'cloudy' }),
        toolCallId: call.toolCallId,
      })
    }
    return next
  }
  return messages
}

const main = async (): Promise<void> => {
  const seed: ProviderMessage[] = [
    {
      role: 'system',
      content: 'You are a brief weather assistant. Always check with the get_weather tool before answering.',
    },
    { role: 'user', content: "What's the weather in Prague right now?" },
  ]

  const afterFirst = await round(seed, 'turn 1 — expect tool call')
  if (afterFirst === seed) {
    console.error('FAIL: no tool call on turn 1')
    process.exit(2)
  }
  await round(afterFirst, 'turn 2 — expect final answer using tool result')
}

await main()

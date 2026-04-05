import { Orchestrator } from './src/agent/Orchestrator.ts'
import { createLlmClient } from './src/llm/client.ts'

const llm = createLlmClient()
const orch = new Orchestrator({ llm })

const messages = [
  'Hello! Can you introduce yourself?',
  'What time is it in Tokyo right now?',
  'Search for the latest news about AI agents',
  'Help me write a short poem about coding',
]

console.log('=== Helper Agent Conversation Test ===\n')
for (const msg of messages) {
  console.log(`You: ${msg}`)
  const response = await orch.handleUserMessage(msg)
  console.log(`Agent: ${response}\n`)
}

llm.close()

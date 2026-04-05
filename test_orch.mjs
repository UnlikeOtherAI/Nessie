import { Orchestrator } from './src/agent/Orchestrator.ts'
import { createLlmClient } from './src/llm/client.ts'

const llm = createLlmClient()
const orch = new Orchestrator({
  defaultAgent: 'main',
  llm,
  callbacks: {
    onStateChange: (state) => console.log('[State]', state.isListening ? 'Listening' : 'Idle')
  }
})

const questions = [
  'Hi! What is your name?',
  'What can you help me with today?',
  'Can you search the web for something for me?',
]

for (const q of questions) {
  console.log(`\nYou: ${q}`)
  const response = await orch.handleUserMessage(q)
  console.log(`Agent: ${response}`)
}

llm.close()

import { RealtimeClient } from './voice/index.js'
import { Orchestrator } from './agent/Orchestrator.js'

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? ''

async function main() {
  console.log('Helper Agent starting...')

  const orchestrator = new Orchestrator({
    defaultAgent: 'main',
    callbacks: {
      onStateChange: (state) => {
        console.log('State:', JSON.stringify(state, null, 2))
      },
    },
  })

  // Wire voice layer
  const voiceClient = new RealtimeClient({
    apiKey: OPENAI_API_KEY,
    model: 'gpt-realtime-1.5',
    callbacks: {
      onTranscript: async (text) => {
        if (!text.trim()) return
        console.log('User said:', text)
        const response = await orchestrator.handleUserMessage(text)
        console.log('Agent:', response)
      },
      onConnected: () => console.log('Voice: connected'),
      onDisconnected: () => console.log('Voice: disconnected'),
      onError: (err) => console.error('Voice error:', err),
    },
  })

  await voiceClient.connect()
  console.log('Ready. Say "Hey Agent" or type a message.')
}

main().catch(console.error)

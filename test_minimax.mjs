import { createLlmClient } from './src/llm/client.ts'

const llm = createLlmClient()
const r = await llm.chat([{role:'user', content:'Say hello in one sentence.'}])
console.log('MiniMax response:', r)
llm.close()

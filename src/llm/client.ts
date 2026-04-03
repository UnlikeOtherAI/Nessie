export type LlmMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type LlmOptions = {
  model?: string
  maxTokens?: number
  temperature?: number
}

export interface LlmClient {
  chat(messages: LlmMessage[], options?: LlmOptions): Promise<string>
  close(): void
}

// ---------------------------------------------------------------------------
// OpenAI Chat API
// ---------------------------------------------------------------------------

function createOpenAiClient(apiKey: string, model = 'gpt-4o'): LlmClient {
  return {
    async chat(messages, options) {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: options?.model ?? model,
          messages,
          max_tokens: options?.maxTokens ?? 1024,
          temperature: options?.temperature ?? 0.7,
        }),
      })
      if (!res.ok) {
        const err = await res.text()
        throw new Error(`OpenAI API error ${res.status}: ${err}`)
      }
      const json = (await res.json()) as { choices: { message: { content: string } }[] }
      return json.choices[0]?.message?.content ?? ''
    },
    close() {},
  }
}

// ---------------------------------------------------------------------------
// MiniMax (Anthropic-compatible endpoint)
// ---------------------------------------------------------------------------

function createMiniMaxClient(apiKey: string, model = 'MiniMax-M2.5'): LlmClient {
  return {
    async chat(messages, options) {
      const res = await fetch('https://api.minimax.io/v1/text/chatcompletion_v2', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: options?.model ?? model,
          messages,
          max_tokens: options?.maxTokens ?? 1024,
          temperature: options?.temperature ?? 0.7,
        }),
      })
      if (!res.ok) {
        const err = await res.text()
        throw new Error(`MiniMax API error ${res.status}: ${err}`)
      }
      const json = (await res.json()) as {
        choices?: { message: { role: string; content: string } }[]
        base_resp?: { status_code: number; status_msg: string }
      }
      if (json.base_resp && json.base_resp.status_code !== 0) {
        throw new Error(`MiniMax API error: ${json.base_resp.status_msg}`)
      }
      return json.choices?.[0]?.message?.content ?? ''
    },
    close() {},
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createLlmClient(): LlmClient {
  const provider = process.env.LLM_PROVIDER ?? 'openai'

  if (provider === 'minimax') {
    const key = process.env.MINIMAX_API_KEY
    if (!key) throw new Error('MINIMAX_API_KEY is not set')
    return createMiniMaxClient(key)
  }

  // Default: OpenAI
  const key = process.env.OPENAI_CHAT_API_KEY ?? process.env.OPENAI_API_KEY
  if (!key) throw new Error('OPENAI_API_KEY / OPENAI_CHAT_API_KEY is not set')
  return createOpenAiClient(key)
}

import { createServer, type Server, type ServerResponse } from 'node:http'
import type { IncomingMessage } from 'node:http'
import type { ProviderMessage } from '@nessie/runtime'
import { MockLlmEngine, type MockCompletionTurn } from './engine.js'
import type { MockScenario, MockStream } from './scenario.js'

// OpenAI-compatible HTTP facade over the scripted engine. The worker's real
// OpenAI-compatible connector talks to this exactly as it would to a hosted
// provider — SSE streaming, tool calls, error shapes, and embeddings included —
// so full-pipeline smoke and load runs exercise the production inference path
// with zero token spend.

export const MOCK_EMBEDDING_DIMENSIONS = 1536

export type MockLlmServer = {
  close: () => Promise<void>
  port: number
  stats: () => ReturnType<MockLlmEngine['stats']>
  url: string
}

type OpenAiRequestMessage = {
  content?: string | null
  role: string
  tool_call_id?: string
  tool_calls?: Array<{ function?: { name?: string } }>
}

type ChatCompletionBody = {
  messages?: OpenAiRequestMessage[]
  stream?: boolean
}

const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

const sendProviderError = (
  response: ServerResponse,
  error: { code: string | null; message: string; status: number; type: string },
): void => {
  sendJson(response, error.status, {
    error: {
      code: error.code,
      message: error.message,
      type: error.type,
    },
  })
}

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

// Map the OpenAI wire shape back to provider messages so turn selection runs on
// the exact same rule as the in-process adapter (assistant-turn count).
const toProviderMessages = (messages: OpenAiRequestMessage[]): ProviderMessage[] =>
  messages.map((message) => {
    if (message.role === 'assistant') {
      return {
        content: message.content ?? '',
        role: 'assistant',
        toolCalls: (message.tool_calls ?? []).map((toolCall, index) => ({
          arguments: {},
          toolCallId: `wire-call-${index}`,
          toolName: toolCall.function?.name ?? 'unknown',
        })),
      }
    }
    if (message.role === 'tool') {
      return {
        content: message.content ?? '',
        role: 'tool',
        toolCallId: message.tool_call_id ?? 'unknown',
      }
    }
    if (message.role === 'system') {
      return { content: message.content ?? '', role: 'system' }
    }
    return { content: message.content ?? '', role: 'user' }
  })

const toOpenAiToolCalls = (turn: MockCompletionTurn, idPrefix: string) =>
  turn.toolCalls.map((toolCall, index) => ({
    function: {
      arguments: JSON.stringify(toolCall.arguments),
      name: toolCall.toolName,
    },
    id: toolCall.toolCallId ?? `${idPrefix}-call-${turn.turnIndex}-${index}`,
    type: 'function' as const,
  }))

const toOpenAiFinishReason = (turn: MockCompletionTurn): string => {
  if (turn.finishReason === 'tool-call') {
    return 'tool_calls'
  }
  if (turn.finishReason) {
    return turn.finishReason === 'content-filter' ? 'content_filter' : turn.finishReason
  }
  return turn.toolCalls.length > 0 ? 'tool_calls' : 'stop'
}

const usageFor = (turn: MockCompletionTurn) => ({
  completion_tokens: turn.usage.outputTokens ?? 0,
  prompt_tokens: turn.usage.inputTokens ?? 0,
  total_tokens: (turn.usage.inputTokens ?? 0) + (turn.usage.outputTokens ?? 0),
})

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()

const streamCompletion = async (
  response: ServerResponse,
  engine: MockLlmEngine,
  turn: MockCompletionTurn,
  completionId: string,
): Promise<void> => {
  response.writeHead(200, {
    'cache-control': 'no-cache',
    'content-type': 'text/event-stream',
  })
  const created = Math.floor(Date.now() / 1000)
  const writeChunk = (payload: Record<string, unknown>): void => {
    response.write(`data: ${JSON.stringify(payload)}\n\n`)
  }
  const baseChoice = { index: 0, finish_reason: null }

  const stream: MockStream = turn.stream ?? { chunkDelayMs: 0, chunkSize: turn.text.length || 1 }

  // Reasoning models emit their visible thinking as `reasoning_content` deltas
  // before any answer text or tool call, so the worker's thought recorder sees
  // the same ordering it would from a real provider.
  const reasoning = turn.reasoning ?? ''
  for (let offset = 0; offset < reasoning.length; offset += stream.chunkSize) {
    writeChunk({
      choices: [{
        ...baseChoice,
        delta: {
          reasoning_content: reasoning.slice(offset, offset + stream.chunkSize),
          role: 'assistant',
        },
      }],
      created,
      id: completionId,
      model: engine.model,
      object: 'chat.completion.chunk',
    })
    await sleep(stream.chunkDelayMs)
  }

  for (let offset = 0; offset < turn.text.length; offset += stream.chunkSize) {
    writeChunk({
      choices: [{ ...baseChoice, delta: { content: turn.text.slice(offset, offset + stream.chunkSize), role: 'assistant' } }],
      created,
      id: completionId,
      model: engine.model,
      object: 'chat.completion.chunk',
    })
    await sleep(stream.chunkDelayMs)
  }

  for (const [index, toolCall] of toOpenAiToolCalls(turn, completionId).entries()) {
    writeChunk({
      choices: [{
        ...baseChoice,
        delta: {
          role: 'assistant',
          tool_calls: [{
            function: { arguments: toolCall.function.arguments, name: toolCall.function.name },
            id: toolCall.id,
            index,
            type: 'function',
          }],
        },
      }],
      created,
      id: completionId,
      model: engine.model,
      object: 'chat.completion.chunk',
    })
  }

  writeChunk({
    choices: [{ delta: {}, finish_reason: toOpenAiFinishReason(turn), index: 0 }],
    created,
    id: completionId,
    model: engine.model,
    object: 'chat.completion.chunk',
  })
  writeChunk({
    choices: [],
    created,
    id: completionId,
    model: engine.model,
    object: 'chat.completion.chunk',
    usage: usageFor(turn),
  })
  response.write('data: [DONE]\n\n')
  response.end()
}

// Deterministic unit-ish vector: identical for identical input position, right
// dimension for the pgvector columns, and clearly synthetic (first slot 1).
const mockEmbedding = (): number[] => {
  const vector = new Array<number>(MOCK_EMBEDDING_DIMENSIONS).fill(0)
  vector[0] = 1
  return vector
}

export const createMockLlmServer = async (input: {
  host?: string
  port?: number
  scenario: MockScenario
}): Promise<MockLlmServer> => {
  const engine = new MockLlmEngine(input.scenario)
  let sequence = 0

  const handleChatCompletion = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    let body: ChatCompletionBody
    try {
      body = JSON.parse(await readBody(request)) as ChatCompletionBody
    } catch {
      sendProviderError(response, {
        code: 'invalid_request',
        message: 'Request body is not valid JSON',
        status: 400,
        type: 'invalid_request_error',
      })
      return
    }
    if (!Array.isArray(body.messages)) {
      sendProviderError(response, {
        code: 'invalid_request',
        message: 'Request body is missing a messages array',
        status: 400,
        type: 'invalid_request_error',
      })
      return
    }

    const outcome = await engine.next(toProviderMessages(body.messages))
    if (outcome.kind === 'error') {
      sendProviderError(response, outcome.error)
      return
    }

    sequence += 1
    const completionId = `chatcmpl-mock-${sequence}`
    if (body.stream) {
      await streamCompletion(response, engine, outcome, completionId)
      return
    }

    sendJson(response, 200, {
      choices: [{
        finish_reason: toOpenAiFinishReason(outcome),
        index: 0,
        message: {
          content: outcome.text,
          role: 'assistant',
          ...(outcome.toolCalls.length > 0
            ? { tool_calls: toOpenAiToolCalls(outcome, completionId) }
            : {}),
        },
      }],
      created: Math.floor(Date.now() / 1000),
      id: completionId,
      model: engine.model,
      object: 'chat.completion',
      usage: usageFor(outcome),
    })
  }

  const handleEmbeddings = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const body = JSON.parse(await readBody(request)) as { input?: string | string[] }
    const inputs = Array.isArray(body.input) ? body.input : [body.input ?? '']
    sendJson(response, 200, {
      data: inputs.map((_, index) => ({
        embedding: mockEmbedding(),
        index,
        object: 'embedding',
      })),
      model: 'mock-embedding',
      object: 'list',
      usage: { prompt_tokens: 1, total_tokens: 1 },
    })
  }

  const server: Server = createServer((request, response) => {
    const path = (request.url ?? '').replace(/^\/v1(?=\/)/, '')
    void (async () => {
      if (request.method === 'POST' && path === '/chat/completions') {
        await handleChatCompletion(request, response)
        return
      }
      if (request.method === 'POST' && path === '/embeddings') {
        await handleEmbeddings(request, response)
        return
      }
      if (request.method === 'GET' && path === '/models') {
        sendJson(response, 200, {
          data: [{ created: 0, id: engine.model, object: 'model', owned_by: 'mock-llm' }],
          object: 'list',
        })
        return
      }
      if (request.method === 'GET' && path === '/health') {
        sendJson(response, 200, { scenario: engine.scenarioName, status: 'ok' })
        return
      }
      sendJson(response, 404, { error: { message: `No mock route for ${request.method} ${request.url}` } })
    })().catch((error: unknown) => {
      if (!response.headersSent) {
        sendProviderError(response, {
          code: 'mock_internal',
          message: error instanceof Error ? error.message : String(error),
          status: 500,
          type: 'server_error',
        })
      } else {
        response.end()
      }
    })
  })

  const host = input.host ?? '127.0.0.1'
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(input.port ?? 0, host, () => resolveListen())
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0

  return {
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()))
      }),
    port,
    stats: () => engine.stats(),
    url: `http://${host}:${port}`,
  }
}

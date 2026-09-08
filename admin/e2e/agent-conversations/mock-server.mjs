// A content-keyed, request-recording OpenAI-compatible endpoint.
//
// `@nessie/mock-llm`'s `createMockLlmServer` is the repo's usual mock, and it
// is the wrong instrument for exactly two of this suite's claims. Its engine
// picks a turn by counting assistant messages in the request, so it cannot
// answer *this thread's* question with *this thread's* sentinel — and it keeps
// no request log, so "the two conversations never saw each other's turns"
// could not be proved from the inference side at all. Both are the point of
// the isolation case, so this file is its own server: same wire shape
// (`packages/mock-llm/src/server.ts` — SSE deltas, tool_calls, usage,
// embeddings), different selection rule.
//
// Selection is structural where it can be and keyed on the suite's own
// sentinels where it cannot: nothing here inspects a person's phrasing beyond
// the fixed strings this suite itself sent.
import { createServer } from 'node:http'

/** The block `buildConversationRoutingBlock` writes into the PA's system prompt. */
export const CONVERSATION_ROUTING_MARKER = 'Conversations with other agents:'
/** The suite's own instruction to the assistant, matched verbatim. */
export const START_PHRASE = 'start a conversation with'

const SSE_HEADERS = { 'cache-control': 'no-cache', 'content-type': 'text/event-stream' }

const readBody = async (request) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

const sendJson = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

const sleep = (ms) => (ms > 0 ? new Promise((done) => { setTimeout(done, ms) }) : Promise.resolve())

const textOf = (message) => (typeof message?.content === 'string' ? message.content : '')

const lastOfRole = (messages, role) => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === role) return messages[index]
  }
  return null
}

/**
 * The single reply this request gets, decided from the request alone.
 *
 * `tools` present ⇒ main inference; absent ⇒ one of the worker's utility
 * judgements, which get a short neutral answer rather than a scripted turn.
 */
const decide = (body, plan) => {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const system = messages.filter((message) => message.role === 'system').map(textOf).join('\n')
  const user = textOf(lastOfRole(messages, 'user'))
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0

  if (!hasTools) return { latencyMs: 0, text: '{}' }

  // A tool result came back: the assistant's next turn is its answer about it.
  // Checked before the start phrase, because the request that carries the
  // result still carries the user turn that asked for it.
  if (messages.some((message) => message.role === 'tool')) {
    return { latencyMs: 0, text: 'Started — see the card.' }
  }

  if (system.includes(CONVERSATION_ROUTING_MARKER) && user.includes(START_PHRASE)) {
    // "…with <agent> about <the job>" — the suite writes the sentence, so this
    // is reading back its own fixed shape, not parsing a person's language.
    const about = user.split(/\babout\b/u).slice(1).join('about').trim()
    return {
      latencyMs: 0,
      text: '',
      toolCalls: [{
        arguments: {
          agent: plan.targetAgentName,
          message: about || plan.fallbackJob,
          title: plan.conversationTitle,
        },
        toolCallId: `mock-conversation-start-${Date.now()}`,
        toolName: 'agent_conversation_start',
      }],
    }
  }

  // Every other main turn is an echo of what it was asked, which is what makes
  // a reply attributable to the thread that asked for it. The latency is the
  // suite's only way to photograph a run mid-flight.
  return { latencyMs: plan.echoLatencyMs, text: `Echo: ${user}` }
}

const openAiToolCalls = (turn, completionId) =>
  (turn.toolCalls ?? []).map((toolCall, index) => ({
    function: { arguments: JSON.stringify(toolCall.arguments), name: toolCall.toolName },
    id: toolCall.toolCallId ?? `${completionId}-call-${index}`,
    type: 'function',
  }))

const finishReason = (turn) => ((turn.toolCalls?.length ?? 0) > 0 ? 'tool_calls' : 'stop')

const usage = () => ({ completion_tokens: 12, prompt_tokens: 101, total_tokens: 113 })

const streamCompletion = async (response, model, turn, completionId) => {
  response.writeHead(200, SSE_HEADERS)
  const created = Math.floor(Date.now() / 1000)
  const write = (payload) => { response.write(`data: ${JSON.stringify(payload)}\n\n`) }
  const envelope = (choices) => ({
    choices, created, id: completionId, model, object: 'chat.completion.chunk',
  })
  const chunkSize = 16
  for (let offset = 0; offset < turn.text.length; offset += chunkSize) {
    write(envelope([{
      delta: { content: turn.text.slice(offset, offset + chunkSize), role: 'assistant' },
      finish_reason: null,
      index: 0,
    }]))
    await sleep(5)
  }
  for (const [index, toolCall] of openAiToolCalls(turn, completionId).entries()) {
    write(envelope([{
      delta: {
        role: 'assistant',
        tool_calls: [{
          function: { arguments: toolCall.function.arguments, name: toolCall.function.name },
          id: toolCall.id,
          index,
          type: 'function',
        }],
      },
      finish_reason: null,
      index: 0,
    }]))
  }
  write(envelope([{ delta: {}, finish_reason: finishReason(turn), index: 0 }]))
  write({ ...envelope([]), usage: usage() })
  response.write('data: [DONE]\n\n')
  response.end()
}

/**
 * @param plan.targetAgentName  The agent `agent_conversation_start` is told to open with.
 * @param plan.conversationTitle Title the scripted tool call asks for.
 * @param plan.echoLatencyMs    Delay before an echo answers, so a run can be photographed running.
 */
export const startMockModelServer = async (plan) => {
  const model = 'mock-model'
  /** Every main-inference request, in order: the isolation proof reads this. */
  const requests = []
  let sequence = 0

  const handleChat = async (request, response) => {
    let body
    try {
      body = JSON.parse(await readBody(request))
    } catch {
      sendJson(response, 400, {
        error: { code: 'invalid_request', message: 'body is not JSON', type: 'invalid_request_error' },
      })
      return
    }
    const messages = Array.isArray(body.messages) ? body.messages : []
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0
    if (hasTools) {
      requests.push({
        messages: messages.map((message) => ({ content: textOf(message), role: message.role })),
        receivedAt: Date.now(),
        toolNames: body.tools.map((tool) => tool?.function?.name ?? tool?.name ?? 'unknown'),
      })
    }
    const turn = decide(body, plan)
    await sleep(turn.latencyMs ?? 0)
    sequence += 1
    const completionId = `chatcmpl-agentconv-${sequence}`
    if (body.stream) {
      await streamCompletion(response, model, turn, completionId)
      return
    }
    sendJson(response, 200, {
      choices: [{
        finish_reason: finishReason(turn),
        index: 0,
        message: {
          content: turn.text,
          role: 'assistant',
          ...((turn.toolCalls?.length ?? 0) > 0
            ? { tool_calls: openAiToolCalls(turn, completionId) }
            : {}),
        },
      }],
      created: Math.floor(Date.now() / 1000),
      id: completionId,
      model,
      object: 'chat.completion',
      usage: usage(),
    })
  }

  const server = createServer((request, response) => {
    const path = (request.url ?? '').replace(/^\/v1(?=\/)/u, '').split('?')[0]
    void (async () => {
      if (request.method === 'POST' && path === '/chat/completions') {
        await handleChat(request, response)
        return
      }
      if (request.method === 'POST' && path === '/embeddings') {
        const body = JSON.parse(await readBody(request))
        const inputs = Array.isArray(body.input) ? body.input : [body.input ?? '']
        const { EMBEDDING_DIMENSIONS } = await import('@nessie/schemas')
        const vector = new Array(EMBEDDING_DIMENSIONS).fill(0)
        vector[0] = 1
        sendJson(response, 200, {
          data: inputs.map((_, index) => ({ embedding: vector, index, object: 'embedding' })),
          model: 'mock-embedding',
          object: 'list',
          usage: { prompt_tokens: 1, total_tokens: 1 },
        })
        return
      }
      if (request.method === 'GET' && path === '/models') {
        sendJson(response, 200, {
          data: [{ created: 0, id: model, object: 'model', owned_by: 'agent-conversations-e2e' }],
          object: 'list',
        })
        return
      }
      sendJson(response, 404, { error: { message: `No mock route for ${request.method} ${request.url}` } })
    })().catch((error) => {
      if (response.headersSent) response.end()
      else {
        sendJson(response, 500, {
          error: { code: 'mock_internal', message: String(error), type: 'server_error' },
        })
      }
    })
  })

  await new Promise((ready, failed) => {
    server.once('error', failed)
    server.listen(0, '127.0.0.1', () => ready())
  })
  const { port } = server.address()
  return {
    close: () => new Promise((done, failed) => {
      server.close((error) => (error ? failed(error) : done()))
    }),
    /** Main-inference requests, oldest first. Never mutated by a reader. */
    requests: () => requests.map((entry) => ({ ...entry, messages: [...entry.messages] })),
    url: `http://127.0.0.1:${port}`,
  }
}

import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  verifyLocalInferenceEnvelope,
} from '@nessie/local-inference-host'
import type {
  LocalInferenceAttemptRequest,
  LocalInferenceResult,
  LocalInferenceSignedEnvelope,
} from '@nessie/schemas'
import { LocalInferenceAttemptFrameSchema } from '@nessie/schemas'

import { LocalInferenceHostLoop } from '../src/local-inference-host.js'
import { LocalInferenceCoordinator } from '../src/local-inference-coordinator.js'
import { EncryptedLocalInferenceReceiptJournal } from '../src/local-inference-receipts.js'
import { OllamaChatError, streamOllamaChat } from '../src/ollama-chat.js'
import type { LocalInferenceDaemonApi } from '../src/local-inference-api.js'
import type { OllamaFetch } from '../src/ollama-client.js'

const HOST_ID = '11111111-1111-4111-8111-111111111111'
const ORG_ID = '22222222-2222-4222-8222-222222222222'
const ATTEMPT_ID = '33333333-3333-4333-8333-333333333333'
const BINDING_ID = '44444444-4444-4444-8444-444444444444'
const RUN_ID = '55555555-5555-4555-8555-555555555555'
const DIGEST = 'a'.repeat(64)
const RESOURCE_ID = '66666666-6666-4666-8666-666666666666'
const ADMISSION = { admissionId: '77777777-7777-4777-8777-777777777777', fence: '88888888-8888-4888-8888-888888888888', resourceId: RESOURCE_ID }

const coordinatorFixture = async (t: import('node:test').TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-host-coordinator-'))
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  return LocalInferenceCoordinator.open({ directory, security: process.platform === 'win32' ? { helper: async () => undefined } : {} })
}

const machineKeys = (): { privateKey: string; publicKey: string } => {
  const keys = generateKeyPairSync('ed25519')
  return {
    privateKey: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
  }
}

const attempt = (): LocalInferenceAttemptRequest => ({
  attemptId: ATTEMPT_ID,
  bindingId: BINDING_ID,
  bindingRevision: 1,
  deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  hostEpoch: 1,
  hostId: HOST_ID,
  invocationId: 'invocation-1',
  maxOutputTokens: 64,
  messages: [{ content: 'Say hello', role: 'user' }],
  modelDigest: DIGEST,
  modelName: 'local:latest',
  numCtx: 8192,
  protocolVersion: 1,
  runFence: 'run-fence-1',
  runId: RUN_ID,
  tools: [],
})

const json = (value: unknown): Response => new Response(JSON.stringify(value), {
  headers: { 'content-type': 'application/json' },
})

const ollama = (chatLines: unknown[], contextLength: number | null = 8192): OllamaFetch => (url) => {
  if (url.endsWith('/api/version')) return Promise.resolve(json({ version: '0.34.1' }))
  if (url.endsWith('/api/tags')) {
    return Promise.resolve(json({ models: [{ digest: DIGEST, name: 'local:latest', size: 7 }] }))
  }
  if (url.endsWith('/api/show')) {
    return Promise.resolve(json({
      capabilities: ['completion', 'tools'],
      details: { family: 'gemma' },
      model_info: contextLength === null ? {} : { 'general.context_length': contextLength },
    }))
  }
  if (url.endsWith('/api/chat')) {
    return Promise.resolve(new Response(`${chatLines.map((line) => JSON.stringify(line)).join('\n')}\n`))
  }
  throw new Error(`Unexpected local call ${url}`)
}

const localResult = (): LocalInferenceResult => ({
  capability: {
    discoveredAt: new Date().toISOString(),
    model: 'local:latest',
    provider: 'local_device',
    source: 'live',
    structuredOutputMode: 'text-only',
    supportsChat: true,
    supportsEmbeddings: false,
    supportsModelDiscovery: true,
    supportsStreaming: true,
    supportsVision: false,
    systemPromptMode: 'native',
    toolCallingMode: 'disabled',
    toolResultMode: 'native-tool-message',
    usageReporting: {
      cachedInputTokens: false,
      cachedOutputTokens: false,
      cacheReadTokens: false,
      cacheWriteTokens: false,
      inputTokens: true,
      outputTokens: true,
      providerReportedCost: false,
    },
  },
  content: 'saved result',
  finishReason: 'stop',
  modelDigest: DIGEST,
  remoteHost: null,
  remoteModel: null,
  toolCalls: [],
  usage: { inputTokens: 1, outputTokens: 1 },
})

const receiptJournal = () => {
  let stored: { ciphertext: string; iv: string; tag: string; version: 1 } | undefined
  const journal = new EncryptedLocalInferenceReceiptJournal({
    read: async () => stored,
    remove: async () => { stored = undefined },
    write: async (value) => { stored = value },
  }, new Uint8Array(32).fill(7))
  return { getStored: () => stored, journal }
}

type ApiCalls = {
  frames: Array<{ frame: { data: string; sequence: number } }>
  heartbeats: Array<{
    envelope: LocalInferenceSignedEnvelope
    heartbeat: { inventory: unknown[]; paused: boolean }
  }>
  results: Array<{
    envelope: LocalInferenceSignedEnvelope
    receipt: { result: LocalInferenceResult }
  }>
}

const apiFor = (
  lease: LocalInferenceAttemptRequest | null,
  dispatchFence = 1,
): { api: LocalInferenceDaemonApi; calls: ApiCalls } => {
  const calls: ApiCalls = { frames: [], heartbeats: [], results: [] }
  return {
    api: {
      attachResource: async () => ({
        capacity: 1, controlRevision: 1, paused: false, resourceId: RESOURCE_ID, healthReason: null,
      }),
      terminateAttempt: async () => ({ acknowledged: true }),
      claim: async () => ({ connectionEpoch: '2', serverTime: new Date().toISOString() }),
      issueChallenge: async () => ({ challenge: 'a'.repeat(43), expiresAt: new Date().toISOString() }),
      heartbeat: async (input) => {
        calls.heartbeats.push(input)
        return { serverTime: new Date().toISOString() }
      },
      poll: async () => ({
        admission: lease ? ADMISSION : null, attempt: lease, dispatchFence: lease === null ? null : dispatchFence,
      }),
      control: async () => ({ state: 'active' }),
      submitFrame: async (input) => {
        calls.frames.push(input)
        return { acknowledged: true }
      },
      submitResult: async (input) => {
        calls.results.push(input)
        return { acknowledged: true }
      },
    },
    calls,
  }
}

test('the host relays a fixed typed Ollama request and signs independent daemon lanes', async (t) => {
  const keys = machineKeys()
  const { journal } = receiptJournal()
  const { api, calls } = apiFor(attempt())
  const loop = new LocalInferenceHostLoop({
    api,
    coordinator: await coordinatorFixture(t),
    fetchImpl: ollama([
      { done: false, message: { content: 'hello' }, model: 'local:latest' },
      { done: true, done_reason: 'stop', eval_count: 2, message: { content: '' }, model: 'local:latest', prompt_eval_count: 3 },
    ]),
    identity: { connectionEpoch: '1', hostId: HOST_ID, machinePrivateKey: keys.privateKey, organizationId: ORG_ID },
    isPaused: () => false,
    journal,
    origin: 'http://127.0.0.1:11434',
  })

  await loop.heartbeat()
  const outcome = await loop.pollOnce()

  assert.deepEqual(outcome, { attemptId: ATTEMPT_ID, kind: 'completed' })
  assert.equal(calls.heartbeats.length, 1)
  assert.equal(calls.frames.length, 1)
  assert.equal(Buffer.from(calls.frames[0]?.frame.data ?? '', 'base64url').toString('utf8'),
    JSON.stringify({ type: 'output_text.delta', text: 'hello' }))
  assert.equal(calls.results[0]?.receipt.result.content, 'hello')
  assert.equal(calls.results[0]?.receipt.result.usage.outputTokens, 2)

  const heartbeat = calls.heartbeats[0]
  assert.ok(heartbeat)
  const envelope = heartbeat.envelope
  assert.equal(envelope.purpose, 'heartbeat')
  assert.equal(verifyLocalInferenceEnvelope({
    body: heartbeat.heartbeat,
    envelope,
    machinePublicKey: keys.publicKey,
  }).ok, true)
})

test('a model without a reported context size still produces a signed receipt', async (t) => {
  const keys = machineKeys()
  const { journal } = receiptJournal()
  const { api, calls } = apiFor(attempt())
  const loop = new LocalInferenceHostLoop({
    api,
    coordinator: await coordinatorFixture(t),
    fetchImpl: ollama([
      { done: false, message: { content: 'hello' }, model: 'local:latest' },
      { done: true, done_reason: 'stop', message: { content: '' }, model: 'local:latest' },
    ], null),
    identity: { connectionEpoch: '1', hostId: HOST_ID, machinePrivateKey: keys.privateKey, organizationId: ORG_ID },
    isPaused: () => false,
    journal,
    origin: 'http://127.0.0.1:11434',
  })

  assert.deepEqual(await loop.pollOnce(), { attemptId: ATTEMPT_ID, kind: 'completed' })
  assert.equal(calls.results[0]?.receipt.result.content, 'hello')
  assert.equal(calls.results[0]?.envelope.purpose, 'result')
})

test('a remote marker in any streamed chat object aborts acceptance', async (t) => {
  const keys = machineKeys()
  const { journal } = receiptJournal()
  const { api, calls } = apiFor(attempt())
  const loop = new LocalInferenceHostLoop({
    api,
    coordinator: await coordinatorFixture(t),
    fetchImpl: ollama([{ done: true, message: {}, model: 'local:latest', remote_model: 'cloud:latest' }]),
    identity: { connectionEpoch: '1', hostId: HOST_ID, machinePrivateKey: keys.privateKey, organizationId: ORG_ID },
    isPaused: () => false,
    journal,
    origin: 'http://127.0.0.1:11434',
  })

  await loop.pollOnce()

  assert.equal(calls.results[0]?.receipt.result.content, null)
  assert.equal(calls.results[0]?.receipt.result.finishReason, 'error')
  const error = Buffer.from(calls.frames[0]?.frame.data ?? '', 'base64url').toString('utf8')
  assert.match(error, /protocol_error/)
})

test('a durable encrypted receipt is retried without dialing Ollama again', async (t) => {
  const keys = machineKeys()
  const { getStored, journal } = receiptJournal()
  await journal.record({ attemptId: ATTEMPT_ID, dispatchFence: 1, result: localResult() })
  assert.ok(getStored())
  assert.doesNotMatch(getStored()?.ciphertext ?? '', /saved result/)
  const { api, calls } = apiFor(attempt())
  let ollamaCalls = 0
  const loop = new LocalInferenceHostLoop({
    api,
    coordinator: await coordinatorFixture(t),
    fetchImpl: ((url, init) => {
      ollamaCalls += 1
      return ollama([])(url, init)
    }),
    identity: { connectionEpoch: '1', hostId: HOST_ID, machinePrivateKey: keys.privateKey, organizationId: ORG_ID },
    isPaused: () => false,
    journal,
    origin: 'http://127.0.0.1:11434',
  })

  await loop.pollOnce()

  assert.equal(ollamaCalls, 0)
  assert.equal(calls.results[0]?.receipt.result.content, 'saved result')
  assert.equal(await journal.get({ attemptId: ATTEMPT_ID, dispatchFence: 1 }), undefined)
})

test('a lost poll response keeps its exact request token and cannot admit a second transport', async (t) => {
  const keys = machineKeys()
  const { journal } = receiptJournal()
  const { api } = apiFor(attempt())
  const coordinator = await coordinatorFixture(t)
  const ids: string[] = []
  const original = api.poll
  api.poll = async (input) => {
    ids.push(input.poll.requestId)
    if (ids.length === 1) throw new Error('response interrupted after server commit')
    return original(input)
  }
  const loop = new LocalInferenceHostLoop({
    api, coordinator, fetchImpl: ollama([{ done: true, message: { content: 'done' } }]),
    identity: { connectionEpoch: '1', hostId: HOST_ID, machinePrivateKey: keys.privateKey, organizationId: ORG_ID },
    isPaused: () => false, journal, origin: 'http://127.0.0.1:11434',
  })
  await assert.rejects(loop.pollOnce(), /response interrupted/)
  assert.equal(await coordinator.acquire('different-host'), null)
  await loop.pollOnce()
  assert.equal(ids.length, 2)
  assert.equal(ids[0], ids[1])
  assert.ok(await coordinator.acquire())
})

test('one host can fill two configured slots while a third call waits', async (t) => {
  const keys = machineKeys()
  const { journal } = receiptJournal()
  const { api } = apiFor(attempt())
  const coordinator = await coordinatorFixture(t)
  await coordinator.syncControl({
    resourceId: RESOURCE_ID, capacity: 2, controlRevision: 1, paused: false, healthReason: null,
  })
  api.poll = async () => ({
    admission: { ...ADMISSION, admissionId: randomUUID(), fence: randomUUID() },
    attempt: { ...attempt(), attemptId: randomUUID() }, dispatchFence: 1,
  })
  const finishes: Array<() => void> = []
  const fetchImpl: OllamaFetch = (url, init) => url.endsWith('/api/chat')
    ? Promise.resolve(new Response(new ReadableStream({
      start(controller) {
        finishes.push(() => {
          controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ done: true, message: { content: 'ok' } })}\n`))
          controller.close()
        })
      },
    })))
    : ollama([])(url, init)
  const loop = new LocalInferenceHostLoop({
    api, coordinator, fetchImpl,
    identity: { connectionEpoch: '1', hostId: HOST_ID, machinePrivateKey: keys.privateKey, organizationId: ORG_ID },
    isPaused: () => false, journal, origin: 'http://127.0.0.1:11434',
  })
  const first = loop.pollOnce()
  const until = async (count: number) => {
    const deadline = Date.now() + 2_000
    while (finishes.length < count && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(finishes.length, count)
  }
  await until(1)
  const second = loop.pollOnce()
  await until(2)
  assert.deepEqual(await loop.pollOnce(), { kind: 'idle' })
  for (const finish of finishes) finish()
  assert.equal((await first).kind, 'completed')
  assert.equal((await second).kind, 'completed')
})

test('a signed control response aborts a blocked Ollama stream before its next frame', async (t) => {
  const keys = machineKeys()
  const { journal } = receiptJournal()
  const { api, calls } = apiFor(attempt())
  let aborted = false
  api.control = async () => ({ state: 'cancelled' })
  const loop = new LocalInferenceHostLoop({
    api,
    coordinator: await coordinatorFixture(t),
    controlIntervalMs: 1,
    fetchImpl: ((url, init) => {
      if (url.endsWith('/api/chat')) {
        const signal = init?.signal as AbortSignal
        return Promise.resolve(new Response(new ReadableStream({
          start(controller) {
            signal.addEventListener('abort', () => {
              aborted = true
              controller.error(new Error('aborted'))
            }, { once: true })
          },
        })))
      }
      return ollama([])(url, init)
    }) as OllamaFetch,
    identity: { connectionEpoch: '1', hostId: HOST_ID, machinePrivateKey: keys.privateKey, organizationId: ORG_ID },
    isPaused: () => false,
    journal,
    origin: 'http://127.0.0.1:11434',
  })

  await loop.pollOnce()

  assert.equal(aborted, true)
  assert.equal(calls.frames.length, 1)
  assert.match(Buffer.from(calls.frames[0]?.frame.data ?? '', 'base64url').toString('utf8'), /cancelled/)
})

test('the chat transport refuses a remote result before yielding an event', async () => {
  const controller = new AbortController()
  await assert.rejects(async () => {
    for await (const event of streamOllamaChat({
      attempt: attempt(),
      fetchImpl: ollama([{ done: true, message: {}, model: 'local:latest', remote_host: 'cloud.example' }]),
      origin: 'http://127.0.0.1:11434',
      signal: controller.signal,
      think: false,
    })) {
      void event
      throw new Error('must not yield')
    }
  }, OllamaChatError)
})

test('the chat transport sends Ollama the thinking switch it was given and relays the thinking', async () => {
  let request: Record<string, unknown> | undefined
  const fetchImpl: OllamaFetch = async (url, init) => {
    if (url.endsWith('/api/chat')) request = JSON.parse(String(init.body)) as Record<string, unknown>
    return ollama([
      { done: false, message: { content: '', thinking: 'Weighing ' }, model: 'local:latest' },
      { done: false, message: { content: '', thinking: 'the answer.' }, model: 'local:latest' },
      { done: true, message: { content: 'answer' }, model: 'local:latest' },
    ])(url, init)
  }
  const thinking: string[] = []
  const text: string[] = []
  for await (const event of streamOllamaChat({
    attempt: { ...attempt(), thinking: true }, fetchImpl, origin: 'http://127.0.0.1:11434',
    signal: new AbortController().signal, think: true,
  })) {
    if (event.thinking !== undefined) thinking.push(event.thinking)
    if (event.text !== undefined) text.push(event.text)
  }
  assert.equal(request?.think, true)
  assert.deepEqual(thinking, ['Weighing ', 'the answer.'])
  assert.deepEqual(text, ['answer'])

  for await (const event of streamOllamaChat({
    attempt: attempt(), fetchImpl, origin: 'http://127.0.0.1:11434', signal: new AbortController().signal, think: false,
  })) void event
  assert.equal(request?.think, false)
})

test('a prior turn\'s reasoning goes back to Ollama as the assistant message\'s thinking', async () => {
  let request: Record<string, unknown> | undefined
  const fetchImpl: OllamaFetch = async (url, init) => {
    if (url.endsWith('/api/chat')) request = JSON.parse(String(init.body)) as Record<string, unknown>
    return ollama([{ done: true, message: { content: 'answer' }, model: 'local:latest' }])(url, init)
  }
  for await (const event of streamOllamaChat({
    attempt: {
      ...attempt(),
      messages: [
        { content: 'Say hello', role: 'user' },
        { content: null, reasoning: 'I should greet.', role: 'assistant', toolCalls: [{ arguments: {}, toolCallId: 'c1', toolName: 'safe_tool' }] },
        { content: 'ok', role: 'tool', toolCallId: 'c1' },
      ],
    }, fetchImpl, origin: 'http://127.0.0.1:11434', signal: new AbortController().signal, think: false,
  })) void event
  const messages = request?.messages as Array<Record<string, unknown>>
  assert.equal(messages[1]?.thinking, 'I should greet.')
})

test('an unbounded main attempt omits Ollama num_predict', async () => {
  let request: Record<string, unknown> | undefined
  const fetchImpl: OllamaFetch = async (url, init) => {
    if (url.endsWith('/api/chat')) request = JSON.parse(String(init.body)) as Record<string, unknown>
    return ollama([{ done: true, message: { content: 'answer' }, model: 'local:latest' }])(url, init)
  }
  const unbounded = attempt()
  delete unbounded.maxOutputTokens
  for await (const event of streamOllamaChat({
    attempt: unbounded, fetchImpl, origin: 'http://127.0.0.1:11434', signal: new AbortController().signal,
    think: false,
  })) void event
  assert.equal((request?.options as Record<string, unknown> | undefined)?.num_predict, undefined)
})

test('tool ids are scoped to the durable invocation, not an Ollama-local counter', async () => {
  const toolAttempt = (): LocalInferenceAttemptRequest => ({
    ...attempt(),
    tools: [{ description: 'A safe tool', inputSchema: { type: 'object' }, toolName: 'safe_tool' }],
  })
  const response = [{
    done: true,
    message: { tool_calls: [{ function: { arguments: {}, name: 'safe_tool' } }] },
    model: 'local:latest',
  }]
  const first = toolAttempt()
  const second = { ...toolAttempt(), invocationId: 'invocation-2' }
  const calls = await Promise.all([first, second].map(async (request) => {
    for await (const event of streamOllamaChat({
      attempt: request, fetchImpl: ollama(response), origin: 'http://127.0.0.1:11434', signal: new AbortController().signal,
      think: false,
    })) return event.toolCalls?.[0]?.toolCallId
    return undefined
  }))
  assert.deepEqual(calls, ['invocation-1:ollama-1', 'invocation-2:ollama-1'])
})

test('frame transport rejects malformed base64url before it reaches storage', () => {
  assert.equal(LocalInferenceAttemptFrameSchema.safeParse({
    attemptId: ATTEMPT_ID, data: '%', dispatchFence: 1, sequence: 1,
  }).success, false)
})

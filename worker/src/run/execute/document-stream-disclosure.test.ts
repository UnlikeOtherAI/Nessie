import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import type { PrismaClient } from '@prisma/client'
import {
  KB_DOCUMENT_COMPOSE_TOOL_ID,
  KB_DOCUMENT_EDIT_TOOL_ID,
  type PgRealtimeTransport,
} from '@nessie/runtime'
import { createConsumedSourceSink } from './disclosure-basis.js'
import { runReplyIsRestricted } from './agent-message.js'
import { createDocumentStreamRecorder } from './document-stream.js'
import type { RunContext } from './types.js'

const AGENT_ID = '00000000-0000-4000-8000-000000000001'
const ORGANIZATION_ID = '00000000-0000-4000-8000-000000000002'
const PROJECT_ID = '00000000-0000-4000-8000-000000000003'
const TEAM_ID = '00000000-0000-4000-8000-000000000004'
const CHANNEL_ID = '00000000-0000-4000-8000-000000000005'
const THREAD_ID = '00000000-0000-4000-8000-000000000006'
const RUN_ID = '00000000-0000-4000-8000-000000000007'
const SESSION_ID = '00000000-0000-4000-8000-000000000008'
const SPACE_ID = '00000000-0000-4000-8000-000000000009'
const PAGE_ID = '00000000-0000-4000-8000-000000000010'
const INVOCATION_ID = 'invocation-1'
const TOOL_CALL_ID = 'call-1'

type Published = {
  data: Record<string, unknown>
  event: string
  ephemeral: boolean
}

const contextWith = (
  consumedSources: RunContext['consumedSources'],
): RunContext => ({
  channel: {
    id: CHANNEL_ID,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    systemChannelType: null,
    teamId: TEAM_ID,
  },
  consumedSources,
} as unknown as RunContext)

const makeHarness = (
  isRestricted: () => boolean,
  options: { baseDocument?: string } = {},
) => {
  const chunks: Array<{ content: string; offset: number; sessionId: string }> = []
  const published: Published[] = []
  const sessionUpdates: Array<Record<string, unknown>> = []
  let status = 'streaming'

  const prisma = {
    knowledgePage: {
      findFirst: async () => null,
    },
    knowledgeSpace: {
      findFirst: async () => ({ name: 'Private plans' }),
    },
    runDocumentChunk: {
      deleteMany: async () => {
        chunks.splice(0, chunks.length)
        return { count: 1 }
      },
      create: async (args: {
        data: { content: string; offset: number; sessionId: string }
      }) => {
        chunks.push({ ...args.data })
        return { id: BigInt(chunks.length) }
      },
    },
    runDocumentSession: {
      create: async () => ({ id: SESSION_ID }),
      update: async (args: { data: Record<string, unknown> }) => {
        sessionUpdates.push(args.data)
        if (typeof args.data.status === 'string') status = args.data.status
        return { id: SESSION_ID }
      },
      updateMany: async (args: { data: Record<string, unknown> }) => {
        if (status !== 'streaming' && status !== 'saving') return { count: 0 }
        sessionUpdates.push(args.data)
        if (typeof args.data.status === 'string') status = args.data.status
        return { count: 1 }
      },
    },
    $transaction: async (operations: Array<Promise<unknown>>) => Promise.all(operations),
  } as unknown as PrismaClient

  const realtimeTransport = {
    publishSse: async (
      _threadId: string,
      event: string,
      data: Record<string, unknown>,
    ) => {
      published.push({ data, ephemeral: false, event })
      return undefined as never
    },
    publishSseEphemeral: async (
      _threadId: string,
      event: string,
      data: Record<string, unknown>,
    ) => {
      published.push({ data, ephemeral: true, event })
      return undefined as never
    },
  } as unknown as Pick<PgRealtimeTransport, 'publishSse' | 'publishSseEphemeral'>

  const recorderInput = {
    isRestricted,
    ...(options.baseDocument !== undefined
      ? {
          loadDocument: async () => ({
            content: options.baseDocument!,
            parentPageId: null,
            spaceId: SPACE_ID,
            title: 'Private source.md',
          }),
        }
      : {}),
    prisma,
    persistRestrictionBasis: async () => undefined,
    realtimeTransport,
    run: {
      agentId: AGENT_ID,
      id: RUN_ID,
      organizationId: ORGANIZATION_ID,
      threadId: THREAD_ID,
    },
  }
  const recorder = createDocumentStreamRecorder(recorderInput)
  recorder.beginInvocation(INVOCATION_ID)

  const push = (text: string): void => {
    recorder.handleToolCallDelta({
      id: TOOL_CALL_ID,
      index: 0,
      invocationId: INVOCATION_ID,
      text,
      toolName: KB_DOCUMENT_COMPOSE_TOOL_ID,
    })
  }

  return { chunks, published, push, recorder, sessionUpdates }
}

const settleAsyncPublishes = async (): Promise<void> => {
  // `publishMeta` is intentionally presentation-only and detached from the
  // durable settle barrier, so let its already-resolved promise finish.
  await delay(0)
}

test('document streaming closes monotonically when the run consumes a privileged source', async () => {
  const sink = createConsumedSourceSink()
  const context = contextWith(sink)
  const harness = makeHarness(() => runReplyIsRestricted(context))

  harness.push(
    `{"spaceId":"${SPACE_ID}","title":"Quarterly plan","markdown":"visible prefix `,
  )
  await harness.recorder.settle(TOOL_CALL_ID)
  await settleAsyncPublishes()
  assert.deepEqual(
    harness.published
      .filter((event) => event.event === 'stream.document.delta')
      .map((event) => event.data.content),
    ['visible prefix '],
  )

  // A tool read between model iterations adds a scope the destination does not
  // imply. This is the exact transition the ordinary text-lane regression test
  // covers; the document lane must close at the same point.
  sink.add({ scopeId: '00000000-0000-4000-8000-0000000000ff', scopeType: 'user' })
  assert.equal(runReplyIsRestricted(context), true)
  harness.push('secret suffix')
  await harness.recorder.settle(TOOL_CALL_ID)

  // The sink is additive. Consuming an implied source later cannot reopen the
  // stream, so a later delta remains suppressed too.
  sink.addAll([
    { scopeId: ORGANIZATION_ID, scopeType: 'organization' },
    { scopeId: CHANNEL_ID, scopeType: 'channel' },
  ])
  assert.equal(runReplyIsRestricted(context), true)
  harness.push(' and later secret"}')
  const session = await harness.recorder.settle(TOOL_CALL_ID)
  await harness.recorder.finalizeOutstanding('run_failed')
  await settleAsyncPublishes()

  assert.equal(session?.markdown, 'visible prefix secret suffix and later secret')
  assert.equal(
    harness.chunks.map((chunk) => chunk.content).join(''),
    session?.markdown,
    'the durable lane must retain the whole document for save and gated bootstrap',
  )
  assert.deepEqual(
    harness.published
      .filter((event) => event.event === 'stream.document.delta')
      .map((event) => event.data.content),
    ['visible prefix '],
    'content published after restriction became active',
  )
  const terminal = harness.published.at(-1)
  assert.equal(terminal?.event, 'stream.document.error')
  assert.equal(terminal?.data.restricted, true)
  assert.ok(!JSON.stringify(harness.published).includes('secret suffix'))
  assert.ok(!JSON.stringify(harness.published).includes('later secret'))
})

test('an unrestricted document stream keeps its existing wire bytes and durable bytes', async () => {
  const markdown = '# Résumé\n\nShip 🚢 exactly.\n'
  const harness = makeHarness(() => false)
  harness.push(JSON.stringify({
    markdown,
    spaceId: SPACE_ID,
    title: 'Release notes',
  }))

  const session = await harness.recorder.settle(TOOL_CALL_ID)
  await harness.recorder.finalizeOutstanding('run_failed')
  await settleAsyncPublishes()

  assert.equal(session?.markdown, markdown)
  assert.equal(harness.chunks.map((chunk) => chunk.content).join(''), markdown)
  assert.deepEqual(harness.published, [
    {
      data: {
        agentId: AGENT_ID,
        mode: 'compose',
        runId: RUN_ID,
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        toolCallId: TOOL_CALL_ID,
      },
      ephemeral: false,
      event: 'stream.document.start',
    },
    {
      data: {
        content: markdown,
        offset: 0,
        runId: RUN_ID,
        seq: 1,
        sessionId: SESSION_ID,
      },
      ephemeral: true,
      event: 'stream.document.delta',
    },
    {
      data: {
        parentPageId: undefined,
        parentTitle: undefined,
        runId: RUN_ID,
        sessionId: SESSION_ID,
        spaceId: SPACE_ID,
        spaceName: 'Private plans',
        title: 'Release notes',
      },
      ephemeral: false,
      event: 'stream.document.meta',
    },
    {
      data: {
        reason: 'run_failed',
        runId: RUN_ID,
        sessionId: SESSION_ID,
      },
      ephemeral: false,
      event: 'stream.document.error',
    },
  ])
})

test('a restricted edit keeps its full snapshot durable but publishes no edit site or text', async () => {
  const harness = makeHarness(() => true, { baseDocument: 'alpha beta gamma' })
  harness.recorder.handleToolCallDelta({
    id: TOOL_CALL_ID,
    index: 0,
    invocationId: INVOCATION_ID,
    text: JSON.stringify({
      edits: [{ find: 'beta', replace: 'private replacement' }],
      pageId: PAGE_ID,
    }),
    toolName: KB_DOCUMENT_EDIT_TOOL_ID,
  })

  const session = await harness.recorder.settle(TOOL_CALL_ID)
  await harness.recorder.finalizeOutstanding('run_failed')
  await settleAsyncPublishes()

  assert.equal(session?.markdown, 'alpha private replacement gamma')
  assert.equal(
    harness.chunks.map((chunk) => chunk.content).join(''),
    session?.markdown,
  )
  assert.deepEqual(
    harness.published.map((event) => event.event),
    ['stream.document.start', 'stream.document.error'],
  )
  assert.equal(harness.published[0]?.data.restricted, true)
  assert.equal(harness.published[1]?.data.restricted, true)
  assert.ok(!JSON.stringify(harness.published).includes('private replacement'))
  assert.ok(!JSON.stringify(harness.published).includes('Private source.md'))
})

import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import { createConsumedSourceSink } from './execute/disclosure-basis.js'
import { runWebSearchTool } from './content-tools.js'
import type { BuiltinToolRuntimeContext } from './tool-types.js'

const IDS = {
  agent: '00000000-0000-4000-8000-0000000000a2',
  channel: '00000000-0000-4000-8000-0000000000a3',
  message: '00000000-0000-4000-8000-0000000000a4',
  organization: '00000000-0000-4000-8000-0000000000a5',
  project: '00000000-0000-4000-8000-0000000000a6',
  run: '00000000-0000-4000-8000-0000000000a7',
  team: '00000000-0000-4000-8000-0000000000a8',
  thread: '00000000-0000-4000-8000-0000000000a9',
  user: '00000000-0000-4000-8000-0000000000aa',
}

const SERPER_BODY = {
  organic: [
    {
      title: 'Loch Ness webcam',
      link: 'https://example.com/webcam',
      snippet: 'Watch the loch.',
    },
    {
      title: 'Sightings archive',
      link: 'https://example.org/archive',
      snippet: 'Every reported sighting.',
    },
  ],
  relatedSearches: [{ query: 'loch ness weather' }],
}

type CapturedCreate = { data: Record<string, unknown> }

const makeContext = () => {
  const messageCreates: CapturedCreate[] = []
  const events: Array<{ event: string; data: Record<string, unknown> }> = []
  const prisma = {
    message: {
      create: async (input: CapturedCreate) => {
        messageCreates.push(input)
        return {
          content: input.data.content,
          createdAt: new Date('2026-09-06T12:00:00.000Z'),
          id: IDS.message,
          role: input.data.role,
          threadId: input.data.threadId,
        }
      },
    },
    messageBasisScope: { createMany: async () => ({ count: 0 }) },
    runBasisScope: { createMany: async () => ({ count: 0 }) },
  } as unknown as PrismaClient
  const consumedSources = createConsumedSourceSink()
  const context = {
    agentId: IDS.agent,
    agentKind: 'shared',
    actorContext: {
      actionContext: { effectiveUserId: IDS.user, requestId: 'request-1' },
      actor: { actorId: IDS.user, actorType: 'user' },
      tenant: { organizationId: IDS.organization, teamId: IDS.team },
    },
    channel: { id: IDS.channel, organizationId: IDS.organization, teamId: IDS.team },
    consumedSources,
    ledgerIdentity: {
      requestHeaders: async () => ({ 'X-Nessie-Context': 'signed' }),
    },
    prisma,
    realtimeTransport: {
      publishWs: async (
        _scopes: unknown,
        payload: { event: string; data: Record<string, unknown> },
      ) => {
        events.push(payload)
      },
    },
    run: { id: IDS.run, messageId: IDS.message, threadId: IDS.thread },
    runContext: {
      agent: { id: IDS.agent },
      boundAgentIds: [IDS.agent],
      channel: {
        id: IDS.channel,
        organizationId: IDS.organization,
        projectId: IDS.project,
        teamId: IDS.team,
      },
      consumedSources,
      run: { id: IDS.run, threadId: IDS.thread },
    },
    toolCallId: 'call_1',
  } as unknown as BuiltinToolRuntimeContext
  return { context, events, messageCreates }
}

/**
 * The search itself is Ledger's; what these tests pin is the Nessie half —
 * whether a card was posted, and what it carries. The transport is stubbed at
 * the global `fetch` the runtime uses, so the tool is exercised exactly as the
 * agentic loop calls it.
 */
const withStubbedSearch = async (work: () => Promise<void>): Promise<void> => {
  const realFetch = globalThis.fetch
  const realEnv = { ...process.env }
  process.env.LEDGER_PUBLIC_URL = 'https://ledger.example'
  process.env.LEDGER_PROXY_TOKEN = 'lk_nessie_test'
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(SERPER_BODY), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch
  try {
    await work()
  } finally {
    globalThis.fetch = realFetch
    process.env = realEnv
  }
}

test('a search nobody asked to see posts nothing', async () => {
  await withStubbedSearch(async () => {
    const { context, events, messageCreates } = makeContext()
    const result = await runWebSearchTool(context, 'loch ness sightings')

    assert.equal(messageCreates.length, 0)
    assert.equal(events.length, 0)
    assert.match(result.outputPreview, /Loch Ness webcam/)
    assert.doesNotMatch(result.outputPreview, /search card/)
  })
})

test('present posts one message carrying the card the provider answered with', async () => {
  await withStubbedSearch(async () => {
    const { context, events, messageCreates } = makeContext()
    const result = await runWebSearchTool(context, 'loch ness sightings', {
      count: 2,
      page: 2,
      present: true,
    })

    assert.equal(messageCreates.length, 1)
    const created = messageCreates[0]!.data
    assert.equal(created.role, 'assistant')
    assert.equal(created.threadId, IDS.thread)

    const card = (created.metadata as { webSearch: Record<string, unknown> }).webSearch
    assert.equal(card.schemaVersion, 1)
    assert.equal(card.provider, 'serper')
    assert.equal(card.query, 'loch ness sightings')
    assert.equal(card.page, 2)
    // A page that came back full means the pager may offer another one.
    assert.equal(card.hasMore, true)
    assert.deepEqual(card.related, ['loch ness weather'])
    assert.deepEqual((card.results as Array<{ url: string }>).map((entry) => entry.url), [
      'https://example.com/webcam',
      'https://example.org/archive',
    ])

    // The message reads as a message for every client that is not the card.
    assert.match(String(created.content), /Web results for “loch ness sightings” \(page 2\)/)
    assert.match(String(created.content), /1\. Loch Ness webcam — https:\/\/example\.com\/webcam/)

    assert.equal(events.length, 1)
    assert.equal(events[0]?.event, 'message.new')
    assert.match(result.inputSummary, /\(page 2\) \(presented\)/)
    assert.match(result.outputPreview, /search card/)
  })
})

test('the query reaches the provider as written, not keyword-stripped', async () => {
  const bodies: string[] = []
  const realFetch = globalThis.fetch
  const realEnv = { ...process.env }
  process.env.LEDGER_PUBLIC_URL = 'https://ledger.example'
  process.env.LEDGER_PROXY_TOKEN = 'lk_nessie_test'
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    bodies.push(String(init.body))
    return new Response(JSON.stringify(SERPER_BODY), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  try {
    const { context } = makeContext()
    await runWebSearchTool(context, 'latest web search results')
    assert.equal(JSON.parse(bodies[0]!).q, 'latest web search results')
  } finally {
    globalThis.fetch = realFetch
    process.env = realEnv
  }
})

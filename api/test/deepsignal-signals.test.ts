import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { McpToolResult } from '@nessie/mcp-client'
import { NullSecretResolver } from '@nessie/mcp-manage'

import {
  actOnDeepSignalSignal,
  listDeepSignalSignals,
  parseSignal,
} from '../src/services/deepsignal-signals.js'

/**
 * In-memory Prisma fake for the DeepSignal Signals service. Tests inject a
 * `callTool` seam so no real MCP network path is touched.
 */
const ORG = '00000000-0000-4000-8000-0000000000a1'
const USER = '00000000-0000-4000-8000-0000000000b2'

const makeFake = (instanceExists: boolean) => ({
  mcpServerInstance: {
    findFirst: async () => (instanceExists ? { id: 'inst-1' } : null),
    findUnique: async (args: { select: Record<string, unknown> }) => {
      if ('credentialRef' in args.select) {
        return { id: 'inst-1', credentialRef: null }
      }
      return {
        transportConfig: {},
        lifecycleState: 'active',
        catalogEntry: {
          authConfig: null,
          authMethod: 'bearer',
          defaultTransportConfig: { transport: 'http', url: 'https://ds.example/mcp' },
        },
      }
    },
  },
  mcpServerCredentialOverride: {
    findUnique: async () => null,
  },
})

const asPrisma = (fake: ReturnType<typeof makeFake>): PrismaClient =>
  fake as unknown as PrismaClient

const toolResult = (value: unknown): McpToolResult => ({
  isError: false,
  content: [{ type: 'text', text: JSON.stringify(value) }],
})

const digestPayload = () => ({
  insights: [
    {
      id: 'ins-1',
      headline: 'Competitor raised a Series B',
      whyItMatters: 'Their runway just extended 18 months — expect aggressive pricing.',
      kind: 'risk',
      status: 'active',
      actions: [{ id: 'act-1' }, 'act-2'],
      deepLink: 'https://app.deepsignal.live/insights/ins-1',
      createdAt: '2026-07-11T08:00:00Z',
    },
    { id: 'ins-2', title: 'New grant program opened', status: 'open' },
    { id: 'bad-no-headline' },
  ],
})

test('parseSignal maps a defensive raw insight into a typed record', () => {
  const signal = parseSignal(digestPayload().insights[0])
  assert.ok(signal)
  assert.equal(signal?.id, 'ins-1')
  assert.equal(signal?.kind, 'risk')
  assert.equal(signal?.status, 'active')
  assert.deepEqual(signal?.actionIds, ['act-1', 'act-2'])
  assert.equal(signal?.deepLink, 'https://app.deepsignal.live/insights/ins-1')
  assert.ok(signal?.surfacedAt)
})

test('listDeepSignalSignals returns needs_setup when no user instance exists', async () => {
  const callTool = async (): Promise<McpToolResult> => {
    throw new Error('callTool must not run without an instance')
  }
  const result = await listDeepSignalSignals(
    asPrisma(makeFake(false)),
    { organizationId: ORG, userId: USER, callTool },
    new NullSecretResolver(),
  )
  assert.deepEqual(result, { status: 'needs_setup' })
})

test('listDeepSignalSignals returns parsed digest items over the user instance', async () => {
  const calls: Array<{ toolName: string; args: unknown }> = []
  const callTool = async (input: { toolName: string; args: unknown }): Promise<McpToolResult> => {
    calls.push({ toolName: input.toolName, args: input.args })
    return toolResult(digestPayload())
  }

  const result = await listDeepSignalSignals(
    asPrisma(makeFake(true)),
    { organizationId: ORG, userId: USER, callTool },
    new NullSecretResolver(),
    'all',
  )

  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.toolName, 'insight_digest')
  assert.deepEqual(calls[0]?.args, { include: 'all' })
  assert.equal(result.status, 'ok')
  if (result.status !== 'ok') return
  // The headline-less third entry is dropped; the two valid ones remain.
  assert.equal(result.items.length, 2)
  assert.equal(result.items[0]?.headline, 'Competitor raised a Series B')
  assert.equal(result.items[1]?.headline, 'New grant program opened')
})

test('actOnDeepSignalSignal proxies the action and returns the updated item', async () => {
  const calls: Array<{ toolName: string; args: unknown }> = []
  const callTool = async (input: { toolName: string; args: unknown }): Promise<McpToolResult> => {
    calls.push({ toolName: input.toolName, args: input.args })
    return toolResult({
      insight: { id: 'ins-1', headline: 'Competitor raised a Series B', status: 'done' },
    })
  }

  const result = await actOnDeepSignalSignal(
    asPrisma(makeFake(true)),
    { organizationId: ORG, userId: USER, callTool },
    new NullSecretResolver(),
    'ins-1',
    'done',
  )

  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.toolName, 'insight_act')
  assert.deepEqual(calls[0]?.args, { insightId: 'ins-1', action: 'done' })
  assert.equal(result.status, 'ok')
  if (result.status !== 'ok') return
  assert.equal(result.item?.status, 'done')
})

test('actOnDeepSignalSignal returns needs_setup when no user instance exists', async () => {
  const callTool = async (): Promise<McpToolResult> => {
    throw new Error('callTool must not run without an instance')
  }
  const result = await actOnDeepSignalSignal(
    asPrisma(makeFake(false)),
    { organizationId: ORG, userId: USER, callTool },
    new NullSecretResolver(),
    'ins-1',
    'snooze',
  )
  assert.deepEqual(result, { status: 'needs_setup' })
})

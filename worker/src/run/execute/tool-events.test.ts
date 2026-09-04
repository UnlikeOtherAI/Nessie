import assert from 'node:assert/strict'
import test from 'node:test'

import type { AuthorizedActionContext } from '@nessie/schemas'

import { recordToolEnd } from './tool-events.js'
import type { ExecutionDependencies, RunContext } from './types.js'

test('tool completion redacts before bounding its durable preview', async () => {
  let stored: Record<string, unknown> | undefined
  const deps = {
    prisma: {
      toolCall: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          stored = data
          return {}
        },
      },
    },
    realtimeTransport: { publishWs: async () => undefined },
  } as unknown as ExecutionDependencies
  const context = {
    activeDemonstrationId: null,
    agent: {
      agentKind: 'shared',
      id: '10000000-0000-4000-8000-000000000001',
      systemSlug: null,
    },
    channel: {
      dmKey: null,
      id: '10000000-0000-4000-8000-000000000002',
      organizationId: '10000000-0000-4000-8000-000000000003',
      systemChannelType: null,
    },
    run: {
      id: '10000000-0000-4000-8000-000000000004',
      threadId: '10000000-0000-4000-8000-000000000005',
    },
  } as unknown as RunContext
  const actorContext = {} as AuthorizedActionContext
  const token = ['sk', 'proj', 'abcdefghijklmnopqrstuv'].join('-')

  await recordToolEnd(deps, context, actorContext, {
    argumentsValue: {},
    durationMs: 1,
    inputSummary: 'safe',
    outputPreview: `${'x'.repeat(1189)} ${token}`,
    startedAt: new Date(),
    success: true,
    toolName: 'internal_test_tool',
  })

  const preview = String(stored?.['outputPreview'])
  assert.equal(preview.length, 1200)
  assert.doesNotMatch(preview, /abcdefghijklmnopqrstuv/)
  assert.match(preview, /sk-proj-•+$/)
})

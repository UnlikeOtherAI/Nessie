import assert from 'node:assert/strict'
import test from 'node:test'

import { terminalizeBudgetBlockedRun } from './budget-gate.js'
import type { ExecutionDependencies, RunContext } from './types.js'

test('budget blocking runs the handoff failure guard before terminal writes', async () => {
  const calls: string[] = []
  const guardError = new Error('handoff failure could not be recorded')
  const deps = {
    prisma: {
      message: {
        create: async () => {
          calls.push('message.create')
          return { content: 'blocked', id: 'message-1', role: 'assistant' }
        },
      },
    },
  } as unknown as ExecutionDependencies
  const context = {
    agent: { id: 'agent-1' },
    run: { id: 'run-1', threadId: 'thread-1' },
    task: { id: 'task-1' },
  } as unknown as RunContext

  await assert.rejects(
    terminalizeBudgetBlockedRun(deps, {} as never, context, 'budget exceeded', {
      beforeBlockedRunTerminalization: async () => {
        calls.push('handoff.failure')
        throw guardError
      },
    }),
    (error) => error === guardError,
  )

  assert.deepEqual(calls, ['handoff.failure'])
})

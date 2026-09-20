import assert from 'node:assert/strict'
import test from 'node:test'

import type { RunExecuteJobPayload } from '@nessie/schemas'

import { createRunInference } from './run-inference.js'
import type { ThinkingRecorder } from './thinking-recorder.js'
import type { ExecutionDependencies, RunContext } from './types.js'
import { coverProviderInputComponent } from './provenanced-provider-input.js'

const deps = { prisma: {} } as unknown as ExecutionDependencies
const payload = {
  actorContext: {
    actionContext: { requestId: 'r' },
    actor: { actorId: 'u', actorType: 'user' },
    tenant: { organizationId: 'o', projectId: 'p', teamId: 't' },
  },
} as unknown as RunExecuteJobPayload
const context = {
  agent: {
    agentKind: 'shared', effort: 'low', executionMode: 'inference', id: 'a',
    model: 'only-local', name: 'A', parentAgentId: null, provider: 'local/ollama', systemPrompt: null,
  },
  channel: { organizationId: 'o' },
  run: { createdAt: new Date(), id: 'run', replyPlacement: null, threadId: 'thread' },
  task: { id: 'task' },
} as unknown as RunContext

test('a local-device pin cannot fall through to the Ledger provider resolver', async () => {
  const inference = createRunInference(deps, payload, context, {
    budgetModelOverride: null,
    local: {
      binding: {
        bindingId: 'local-binding', hostEpoch: 1, hostId: 'host',
        manifestDigest: 'a'.repeat(64), modelName: 'only-local', numCtx: 8192, revision: 1,
      },
      runFence: 'fence',
    },
    subscription: null,
    thinkingRecorder: {} as ThinkingRecorder,
    utilityModel: null,
  })

  await assert.rejects(
    inference.runMain([coverProviderInputComponent(
      { content: 'No cloud fallback.', role: 'user' }, 'direct_prompt',
    )], []),
    /secure storage/,
  )
})

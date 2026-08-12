import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import { buildExecutorToolset } from './executor-toolset.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const agentId = '00000000-0000-4000-8000-000000000002'
const runId = '00000000-0000-4000-8000-000000000003'

test('only operations already bound to this run and explicitly granted to its agent reach the model', async () => {
  const prisma = {
    executorBinding: {
      findMany: async () => [
        { id: '00000000-0000-4000-8000-000000000004', operationKey: 'sandbox.stop' },
        { id: '00000000-0000-4000-8000-000000000005', operationKey: 'file.read' },
      ],
    },
    toolRegistryEntry: {
      upsert: async ({ where }: { where: { organizationId_scopeKey_toolId: { toolId: string } } }) => ({
        id: where.organizationId_scopeKey_toolId.toolId,
      }),
    },
  } as unknown as PrismaClient

  const toolset = await buildExecutorToolset(prisma, {
    agentId,
    agentToolPolicy: { 'executor.sandbox.stop': true },
    encryptionSecret: 'test-secret',
    organizationId,
    runId,
  })

  assert.deepEqual(toolset.descriptors.map((descriptor) => descriptor.toolName), ['executor.sandbox.stop'])
  assert.deepEqual([...toolset.handledNames], ['executor.sandbox.stop'])
})

test('the read-only backend exposes bounded schemas and withholds unimplemented operations', async () => {
  const prisma = {
    executorBinding: {
      findMany: async () => [
        { id: '00000000-0000-4000-8000-000000000004', operationKey: 'file.read' },
        { id: '00000000-0000-4000-8000-000000000005', operationKey: 'command.run' },
      ],
    },
    toolRegistryEntry: {
      upsert: async ({ where }: { where: { organizationId_scopeKey_toolId: { toolId: string } } }) => ({
        id: where.organizationId_scopeKey_toolId.toolId,
      }),
    },
  } as unknown as PrismaClient

  const toolset = await buildExecutorToolset(prisma, {
    agentId,
    agentToolPolicy: { 'executor.command.run': true, 'executor.file.read': true },
    encryptionSecret: 'test-secret',
    organizationId,
    runId,
  })

  assert.deepEqual(toolset.descriptors, [{
    description: 'Read a bounded file from an approved executor workspace.',
    inputSchema: {
      additionalProperties: false,
      properties: {
        maxBytes: { maximum: 8_192, minimum: 1, type: 'integer' },
        path: { maxLength: 1_024, minLength: 1, type: 'string' },
      },
      required: ['path'],
      type: 'object',
    },
    toolName: 'executor.file.read',
  }])
})

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
      deleteMany: async () => ({ count: 0 }),
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

test('the bounded backend exposes only an exact session-bound browser bundle and withholds unimplemented operations', async () => {
  const prisma = {
    executorBinding: {
      findMany: async () => [
        {
          id: '00000000-0000-4000-8000-000000000005',
          operationKey: 'browser.open',
          session: { id: '00000000-0000-4000-8000-000000000009', profile: 'workspace_sandbox', status: 'pending' },
        },
        {
          id: '00000000-0000-4000-8000-000000000006',
          operationKey: 'browser.observe',
          session: { id: '00000000-0000-4000-8000-000000000009', profile: 'workspace_sandbox', status: 'pending' },
        },
        {
          id: '00000000-0000-4000-8000-000000000007',
          operationKey: 'sandbox.stop',
          session: { id: '00000000-0000-4000-8000-000000000009', profile: 'workspace_sandbox', status: 'pending' },
        },
      ],
    },
    toolRegistryEntry: {
      deleteMany: async () => ({ count: 0 }),
      upsert: async ({ where }: { where: { organizationId_scopeKey_toolId: { toolId: string } } }) => ({
        id: where.organizationId_scopeKey_toolId.toolId,
      }),
    },
  } as unknown as PrismaClient

  const toolset = await buildExecutorToolset(prisma, {
    agentId,
    agentToolPolicy: {
      'executor.browser.observe': true,
      'executor.browser.open': true,
      'executor.sandbox.stop': true,
    },
    encryptionSecret: 'test-secret',
    organizationId,
    runId,
  })

  assert.deepEqual(toolset.descriptors, [{
    description: 'Observe bounded state from an isolated executor browser.',
    inputSchema: { additionalProperties: false, properties: {}, type: 'object' },
    toolName: 'executor.browser.observe',
  }, {
    description: 'Open a URL in an isolated executor browser.',
    inputSchema: {
      additionalProperties: false,
      properties: { url: { format: 'uri', maxLength: 4_096, type: 'string' } },
      required: ['url'],
      type: 'object',
    },
    toolName: 'executor.browser.open',
  }, {
    description: 'Stop an executor sandbox or session.',
    inputSchema: { additionalProperties: false, properties: {}, type: 'object' },
    toolName: 'executor.sandbox.stop',
  }])
})

test('browser operations are withheld when their session bundle is incomplete or mixed with workspace access', async () => {
  const prisma = {
    executorBinding: {
      findMany: async () => [
        { id: '00000000-0000-4000-8000-000000000004', operationKey: 'file.read', session: null },
        {
          id: '00000000-0000-4000-8000-000000000005',
          operationKey: 'browser.open',
          session: { id: '00000000-0000-4000-8000-000000000009', profile: 'workspace_sandbox', status: 'pending' },
        },
        {
          id: '00000000-0000-4000-8000-000000000006',
          operationKey: 'browser.observe',
          session: { id: '00000000-0000-4000-8000-000000000009', profile: 'workspace_sandbox', status: 'pending' },
        },
        {
          id: '00000000-0000-4000-8000-000000000007',
          operationKey: 'sandbox.stop',
          session: { id: '00000000-0000-4000-8000-000000000009', profile: 'workspace_sandbox', status: 'pending' },
        },
      ],
    },
    toolRegistryEntry: {
      deleteMany: async () => ({ count: 0 }),
      upsert: async ({ where }: { where: { organizationId_scopeKey_toolId: { toolId: string } } }) => ({
        id: where.organizationId_scopeKey_toolId.toolId,
      }),
    },
  } as unknown as PrismaClient
  const toolset = await buildExecutorToolset(prisma, {
    agentId,
    agentToolPolicy: {
      'executor.browser.observe': true,
      'executor.browser.open': true,
      'executor.file.read': true,
      'executor.sandbox.stop': true,
    },
    encryptionSecret: 'test-secret',
    organizationId,
    runId,
  })
  assert.deepEqual(toolset.descriptors.map((descriptor) => descriptor.toolName), [
    'executor.file.read',
  ])
})

test('a stopped browser session exposes no residual browser or stop tool', async () => {
  const prisma = {
    executorBinding: {
      findMany: async () => [
        {
          id: '00000000-0000-4000-8000-000000000005',
          operationKey: 'browser.open',
          session: { id: '00000000-0000-4000-8000-000000000009', profile: 'workspace_sandbox', status: 'stopped' },
        },
        {
          id: '00000000-0000-4000-8000-000000000006',
          operationKey: 'browser.observe',
          session: { id: '00000000-0000-4000-8000-000000000009', profile: 'workspace_sandbox', status: 'stopped' },
        },
        {
          id: '00000000-0000-4000-8000-000000000007',
          operationKey: 'sandbox.stop',
          session: { id: '00000000-0000-4000-8000-000000000009', profile: 'workspace_sandbox', status: 'stopped' },
        },
      ],
    },
    toolRegistryEntry: {
      deleteMany: async () => ({ count: 0 }),
      upsert: async ({ where }: { where: { organizationId_scopeKey_toolId: { toolId: string } } }) => ({
        id: where.organizationId_scopeKey_toolId.toolId,
      }),
    },
  } as unknown as PrismaClient
  const toolset = await buildExecutorToolset(prisma, {
    agentId,
    agentToolPolicy: {
      'executor.browser.observe': true,
      'executor.browser.open': true,
      'executor.sandbox.stop': true,
    },
    encryptionSecret: 'test-secret',
    organizationId,
    runId,
  })
  assert.deepEqual(toolset.descriptors, [])
})

test('the bounded backend exposes coding only through its exact session bundle', async () => {
  const session = {
    id: '00000000-0000-4000-8000-000000000010',
    profile: 'coding_session' as const,
    status: 'pending' as const,
  }
  const prisma = {
    executorBinding: {
      findMany: async () => [
        { id: '00000000-0000-4000-8000-000000000014', operationKey: 'sandbox.stop', session },
        { id: '00000000-0000-4000-8000-000000000013', operationKey: 'workspace.review', session },
        { id: '00000000-0000-4000-8000-000000000012', operationKey: 'coding.observe', session },
        { id: '00000000-0000-4000-8000-000000000011', operationKey: 'coding.launch', session },
      ],
    },
    toolRegistryEntry: {
      deleteMany: async () => ({ count: 0 }),
      upsert: async ({ where }: { where: { organizationId_scopeKey_toolId: { toolId: string } } }) => ({
        id: where.organizationId_scopeKey_toolId.toolId,
      }),
    },
  } as unknown as PrismaClient

  const toolset = await buildExecutorToolset(prisma, {
    agentId,
    agentToolPolicy: {
      'executor.coding.launch': true,
      'executor.coding.observe': true,
      'executor.sandbox.stop': true,
      'executor.workspace.review': true,
    },
    encryptionSecret: 'test-secret',
    organizationId,
    runId,
  })

  assert.deepEqual(toolset.descriptors.map((descriptor) => descriptor.toolName), [
    'executor.coding.launch',
    'executor.coding.observe',
    'executor.sandbox.stop',
    'executor.workspace.review',
  ])
  assert.deepEqual(toolset.descriptors[0]?.inputSchema, {
    additionalProperties: false,
    properties: { prompt: { maxLength: 4_096, minLength: 1, type: 'string' } },
    required: ['prompt'],
    type: 'object',
  })
})

test('coding operations are withheld when their session is mixed with another executor binding', async () => {
  const session = {
    id: '00000000-0000-4000-8000-000000000010',
    profile: 'coding_session' as const,
    status: 'active' as const,
  }
  const prisma = {
    executorBinding: {
      findMany: async () => [
        { id: '00000000-0000-4000-8000-000000000004', operationKey: 'file.read', session: null },
        { id: '00000000-0000-4000-8000-000000000011', operationKey: 'coding.launch', session },
        { id: '00000000-0000-4000-8000-000000000012', operationKey: 'coding.observe', session },
        { id: '00000000-0000-4000-8000-000000000013', operationKey: 'workspace.review', session },
        { id: '00000000-0000-4000-8000-000000000014', operationKey: 'sandbox.stop', session },
      ],
    },
    toolRegistryEntry: {
      deleteMany: async () => ({ count: 0 }),
      upsert: async ({ where }: { where: { organizationId_scopeKey_toolId: { toolId: string } } }) => ({
        id: where.organizationId_scopeKey_toolId.toolId,
      }),
    },
  } as unknown as PrismaClient

  const toolset = await buildExecutorToolset(prisma, {
    agentId,
    agentToolPolicy: {
      'executor.coding.launch': true,
      'executor.coding.observe': true,
      'executor.file.read': true,
      'executor.sandbox.stop': true,
      'executor.workspace.review': true,
    },
    encryptionSecret: 'test-secret',
    organizationId,
    runId,
  })

  assert.deepEqual(toolset.descriptors.map((descriptor) => descriptor.toolName), ['executor.file.read'])
})

test('an exited coding session keeps review and teardown but cannot relaunch Codex', async () => {
  const session = {
    id: '00000000-0000-4000-8000-000000000010',
    profile: 'coding_session' as const,
    status: 'attention' as const,
  }
  const prisma = {
    executorBinding: {
      findMany: async () => [
        { id: '00000000-0000-4000-8000-000000000011', operationKey: 'coding.launch', session },
        { id: '00000000-0000-4000-8000-000000000012', operationKey: 'coding.observe', session },
        { id: '00000000-0000-4000-8000-000000000013', operationKey: 'workspace.review', session },
        { id: '00000000-0000-4000-8000-000000000014', operationKey: 'sandbox.stop', session },
      ],
    },
    toolRegistryEntry: {
      deleteMany: async () => ({ count: 0 }),
      upsert: async ({ where }: { where: { organizationId_scopeKey_toolId: { toolId: string } } }) => ({
        id: where.organizationId_scopeKey_toolId.toolId,
      }),
    },
  } as unknown as PrismaClient
  const toolset = await buildExecutorToolset(prisma, {
    agentId,
    agentToolPolicy: {
      'executor.coding.launch': true,
      'executor.coding.observe': true,
      'executor.sandbox.stop': true,
      'executor.workspace.review': true,
    },
    encryptionSecret: 'test-secret',
    organizationId,
    runId,
  })

  assert.deepEqual(toolset.descriptors.map((descriptor) => descriptor.toolName), [
    'executor.coding.observe',
    'executor.sandbox.stop',
    'executor.workspace.review',
  ])
})

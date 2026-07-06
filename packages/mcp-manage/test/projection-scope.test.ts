import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { McpToolDescriptor } from '@nessie/mcp-client'

import { projectMcpToolDescriptors } from '../src/index.js'

type UpsertCall = { create: { status: string }; update: Record<string, unknown> }

const makeTx = (existing: Array<{
  id: string
  toolId: string
  label: string
  description: string
  inputSchema: unknown
  outputSchema: unknown
}> = []) => {
  const upserts: UpsertCall[] = []
  const updateManys: Array<Record<string, unknown>> = []
  const tx = {
    toolRegistryEntry: {
      findMany: async () => existing,
      upsert: async (args: UpsertCall) => {
        upserts.push(args)
        return {}
      },
      updateMany: async (args: Record<string, unknown>) => {
        updateManys.push(args)
        return { count: 0 }
      },
    },
  } as unknown as Pick<PrismaClient, 'toolRegistryEntry'>
  return { tx, upserts, updateManys }
}

const descriptor: McpToolDescriptor = {
  name: 'search',
  description: 'Search things',
  inputSchema: { type: 'object' },
}

test('user-scope instances project tools as active (self-service, no review gate)', async () => {
  const { tx, upserts } = makeTx()
  await projectMcpToolDescriptors(tx, {
    organizationId: 'org1',
    instance: { id: 'inst1', scopeType: 'user', scopeId: 'user1' },
    descriptors: [descriptor],
  })
  assert.equal(upserts.length, 1)
  assert.equal(upserts[0]?.create.status, 'active')
})

test('shared-scope instances keep the pending_review governance gate', async () => {
  for (const scopeType of ['organization', 'team', 'channel'] as const) {
    const { tx, upserts } = makeTx()
    await projectMcpToolDescriptors(tx, {
      organizationId: 'org1',
      instance: { id: 'inst1', scopeType, scopeId: 'scope1' },
      descriptors: [descriptor],
    })
    assert.equal(upserts[0]?.create.status, 'pending_review', scopeType)
  }
})

test('drift on a user-scope instance re-activates instead of demanding review', async () => {
  const { tx, upserts } = makeTx([
    {
      id: 'entry1',
      toolId: 'mcp:inst1:search',
      label: 'old label',
      description: 'old',
      inputSchema: {},
      outputSchema: null,
    },
  ])
  await projectMcpToolDescriptors(tx, {
    organizationId: 'org1',
    instance: { id: 'inst1', scopeType: 'user', scopeId: 'user1' },
    descriptors: [descriptor],
  })
  assert.equal(upserts[0]?.update.status, 'active')
})

import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { McpToolDescriptor } from '@nessie/mcp-client'

import { projectMcpToolDescriptors } from '../src/index.js'
import {
  fingerprintMcpToolDescriptor,
  MCP_TOOL_DESCRIPTOR_FINGERPRINT_KEY,
} from '../src/mcp-tool-grant-fingerprint.js'

type UpsertCall = { create: { status: string }; update: Record<string, unknown> }

const makeTx = (existing: Array<{
  id: string
  toolId: string
  label: string
  description: string
  inputSchema: unknown
  outputSchema: unknown
}> = [], input: {
  personalAssistantId?: string
  existingDirectGrant?: { id: string }
} = {}) => {
  const upserts: UpsertCall[] = []
  const updateManys: Array<Record<string, unknown>> = []
  const createdGrants: Array<Record<string, unknown>> = []
  const tx = {
    $executeRaw: async () => 0,
    agent: {
      findFirst: async () => input.personalAssistantId
        ? { id: input.personalAssistantId }
        : null,
    },
    toolRegistryEntry: {
      findMany: async () => existing,
      upsert: async (args: UpsertCall) => {
        upserts.push(args)
        return { id: 'projected-entry' }
      },
      updateMany: async (args: Record<string, unknown>) => {
        updateManys.push(args)
        return { count: 0 }
      },
    },
    toolGrant: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        createdGrants.push(data)
        return data
      },
      findFirst: async () => input.existingDirectGrant ?? null,
    },
  } as unknown as Pick<PrismaClient, '$executeRaw' | 'agent' | 'toolGrant' | 'toolRegistryEntry'>
  return { tx, upserts, updateManys, createdGrants }
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

test('a newly projected protected tool seeds a descriptor-bound PA default grant', async () => {
  const { tx, createdGrants } = makeTx([], {
    personalAssistantId: 'personal-assistant',
  })

  await projectMcpToolDescriptors(tx, {
    organizationId: 'org1',
    instance: {
      id: 'inst1',
      requiresExplicitToolGrant: true,
      scopeType: 'user',
      scopeId: 'user1',
    },
    descriptors: [descriptor],
  })

  assert.deepEqual(createdGrants, [{
    agentId: 'personal-assistant',
    config: {
      [MCP_TOOL_DESCRIPTOR_FINGERPRINT_KEY]: fingerprintMcpToolDescriptor({
        annotations: {},
        description: descriptor.description,
        inputSchema: descriptor.inputSchema,
        name: descriptor.name,
        outputSchema: descriptor.outputSchema,
      }),
    },
    roleId: null,
    source: 'agent_override',
    state: 'allowed',
    toolId: 'projected-entry',
  }])
})

test('a direct PA revoke remains in force when a protected descriptor is projected', async () => {
  const { tx, createdGrants } = makeTx([], {
    existingDirectGrant: { id: 'denied-direct-grant' },
    personalAssistantId: 'personal-assistant',
  })

  await projectMcpToolDescriptors(tx, {
    organizationId: 'org1',
    instance: {
      id: 'inst1',
      requiresExplicitToolGrant: true,
      scopeType: 'user',
      scopeId: 'user1',
    },
    descriptors: [descriptor],
  })

  assert.deepEqual(createdGrants, [])
})

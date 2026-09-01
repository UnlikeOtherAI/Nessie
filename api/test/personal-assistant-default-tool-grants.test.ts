import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import {
  fingerprintMcpToolDescriptor,
  MCP_TOOL_DESCRIPTOR_FINGERPRINT_KEY,
  mcpToolDescriptorAnnotationsFromMetadata,
} from '@nessie/mcp-manage'

import {
  reconcilePersonalAssistantDefaultToolGrants,
  reconcilePersonalAssistantDefaultToolGrantsAtStartup,
} from '../src/services/personal-assistant-default-tool-grants.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const agentId = '00000000-0000-4000-8000-000000000002'
const protectedToolId = '00000000-0000-4000-8000-000000000003'

const protectedEntry = {
  description: 'Creates an issue from the project plan.',
  id: protectedToolId,
  inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
  metadata: { requiresExplicitGrant: true },
  outputSchema: { type: 'object', properties: { issueId: { type: 'string' } } },
  toolId: 'mcp:linear-instance:issue_create',
  transportConfig: { toolName: 'issue_create' },
}

const currentFingerprint = fingerprintMcpToolDescriptor({
  annotations: mcpToolDescriptorAnnotationsFromMetadata(protectedEntry.metadata),
  description: protectedEntry.description,
  inputSchema: protectedEntry.inputSchema,
  name: 'issue_create',
  outputSchema: protectedEntry.outputSchema,
})

type GrantFixture = {
  agentId: string | null
  config: unknown
  id: string
  roleId: string | null
  source: string
  state: string
  toolId: string
}

const buildPrisma = (grants: GrantFixture[] = []) => {
  let lockCalls = 0
  let transactionCount = 0
  let directGrantWhere: Record<string, unknown> | undefined
  const tx = {
    $executeRaw: async () => {
      lockCalls += 1
      return 0
    },
    toolRegistryEntry: {
      findMany: async () => [protectedEntry],
    },
    toolGrant: {
      create: async ({ data }: { data: Omit<GrantFixture, 'id'> }) => {
        const grant = { ...data, id: `grant-${grants.length + 1}` }
        grants.push(grant)
        return grant
      },
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        directGrantWhere = where
        return grants.filter((grant) =>
          grant.agentId === where.agentId && grant.roleId === where.roleId)
      },
    },
  }
  const prisma = {
    $transaction: async <T>(action: (client: typeof tx) => Promise<T>) => {
      transactionCount += 1
      return action(tx)
    },
    agent: {
      findMany: async () => [{ id: agentId, organizationId }],
    },
  } as unknown as PrismaClient

  return {
    get directGrantWhere() {
      return directGrantWhere
    },
    get grants() {
      return grants
    },
    get lockCalls() {
      return lockCalls
    },
    prisma,
    get transactionCount() {
      return transactionCount
    },
    tx,
  }
}

test('startup provisions a missing protected MCP grant for each Personal Assistant', async () => {
  const state = buildPrisma()

  assert.deepEqual(
    await reconcilePersonalAssistantDefaultToolGrantsAtStartup(state.prisma),
    { agentCount: 1, grantCount: 1 },
  )
  assert.equal(state.transactionCount, 1)
  assert.equal(state.lockCalls, 1)
  assert.equal(state.directGrantWhere?.state, undefined)
  assert.deepEqual(state.grants, [{
    agentId,
    config: { [MCP_TOOL_DESCRIPTOR_FINGERPRINT_KEY]: currentFingerprint },
    id: 'grant-1',
    roleId: null,
    source: 'agent_override',
    state: 'allowed',
    toolId: protectedToolId,
  }])
})

test('a denied direct PA grant remains revoked during default reconciliation', async () => {
  const deniedGrant: GrantFixture = {
    agentId,
    config: { reason: 'owner revoked it' },
    id: 'denied-grant',
    roleId: null,
    source: 'agent_override',
    state: 'denied',
    toolId: protectedToolId,
  }
  const state = buildPrisma([deniedGrant])

  assert.equal(await reconcilePersonalAssistantDefaultToolGrants(state.tx as never, {
    agentId,
    organizationId,
  }), 0)
  assert.deepEqual(state.grants, [deniedGrant])
})

test('an existing PA descriptor fingerprint is never refreshed', async () => {
  const staleGrant: GrantFixture = {
    agentId,
    config: { [MCP_TOOL_DESCRIPTOR_FINGERPRINT_KEY]: 'sha256:old-consent' },
    id: 'stale-grant',
    roleId: null,
    source: 'agent_override',
    state: 'allowed',
    toolId: protectedToolId,
  }
  const state = buildPrisma([staleGrant])

  assert.equal(await reconcilePersonalAssistantDefaultToolGrants(state.tx as never, {
    agentId,
    organizationId,
  }), 0)
  assert.deepEqual(state.grants, [staleGrant])
})

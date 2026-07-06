import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import { ensureLibrarianAgent, LIBRARIAN_NAME } from '../src/services/librarian.js'

/**
 * ensureLibrarianAgent mirrors ensurePersonalAssistantAgent's upsert-by-kind
 * pattern: repeated calls for the same org must converge on one agent row and
 * must not stack duplicate tool grants. This fake prisma only implements the
 * handful of calls the service makes (agent upsert-by-kind inside a
 * transaction, then registry-entry + grant upserts against the top-level
 * client), matching the style of tool-grants.test.ts.
 */

type AgentRow = {
  id: string
  organizationId: string
  agentKind: string
  systemManaged: boolean
  name: string
  role: string
  surfacePolicy: string
  delegationMode: string
  model: string | null
  provider: string | null
  systemPrompt: string | null
  toolPolicy: unknown
}

type RegistryRow = {
  id: string
  organizationId: string
  scopeKey: string
  toolId: string
}

type GrantRow = {
  id: string
  toolId: string
  agentId: string
  state: string
  source: string
}

const buildFakePrisma = () => {
  const agents: AgentRow[] = []
  const registry: RegistryRow[] = []
  const grants: GrantRow[] = []
  let nextAgentId = 1
  let nextRegistryId = 1
  let nextGrantId = 1

  const agentApi = {
    findFirst: async ({ where }: { where: any }) =>
      agents.find(
        (agent) =>
          agent.organizationId === where.organizationId &&
          agent.agentKind === where.agentKind &&
          agent.systemManaged === where.systemManaged &&
          agent.name === where.name,
      ) ?? null,
    update: async ({ where, data }: { where: { id: string }; data: any }) => {
      const agent = agents.find((a) => a.id === where.id)
      if (!agent) throw new Error('agent not found')
      Object.assign(agent, data)
      return { id: agent.id }
    },
    create: async ({ data }: { data: any }) => {
      const agent: AgentRow = {
        id: `00000000-0000-4000-8000-0000000000a${nextAgentId++}`,
        ...data,
      }
      agents.push(agent)
      return { id: agent.id }
    },
  }

  const toolRegistryEntryApi = {
    upsert: async ({ where, create, update }: { where: any; create: any; update: any }) => {
      const key = where.organizationId_scopeKey_toolId
      const existing = registry.find(
        (row) =>
          row.organizationId === key.organizationId &&
          row.scopeKey === key.scopeKey &&
          row.toolId === key.toolId,
      )
      if (existing) {
        Object.assign(existing, update)
        return { id: existing.id }
      }
      const row: RegistryRow = {
        id: `registry-${nextRegistryId++}`,
        organizationId: create.organizationId,
        scopeKey: create.scopeKey,
        toolId: create.toolId,
      }
      registry.push(row)
      return { id: row.id }
    },
    findFirst: async ({ where }: { where: any }) => {
      const row = registry.find((r) => r.id === where.id)
      if (!row) return null
      const orgMatches = (where.OR as Array<{ organizationId: string | null }>).some(
        (clause) => row.organizationId === clause.organizationId,
      )
      return orgMatches ? { id: row.id } : null
    },
  }

  const toolGrantApi = {
    create: async ({ data }: { data: any }) => {
      const grant: GrantRow = {
        id: `grant-${nextGrantId++}`,
        toolId: data.toolId,
        agentId: data.agentId,
        state: data.state,
        source: data.source,
      }
      grants.push(grant)
      return grant
    },
    findFirst: async ({ where }: { where: any }) =>
      grants.find(
        (grant) =>
          grant.toolId === where.toolId &&
          grant.state === where.state &&
          grant.agentId === (where.agentId ?? null),
      ) ?? null,
  }

  const prisma = {
    $executeRaw: async () => undefined,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    agent: agentApi,
    toolRegistryEntry: toolRegistryEntryApi,
    toolGrant: toolGrantApi,
  }

  return { prisma: prisma as unknown as PrismaClient, agents, registry, grants }
}

const ORG_A = '00000000-0000-4000-8000-00000000000a'

test('ensureLibrarianAgent is idempotent: two calls converge on one agent', async () => {
  const { prisma, agents } = buildFakePrisma()

  const first = await ensureLibrarianAgent(prisma, ORG_A)
  const second = await ensureLibrarianAgent(prisma, ORG_A)

  assert.equal(first, second)
  assert.equal(agents.length, 1)
  assert.equal(agents[0]?.name, LIBRARIAN_NAME)
  assert.equal(agents[0]?.systemManaged, true)
})

test('ensureLibrarianAgent grants its tool set without stacking duplicate grants', async () => {
  const { prisma, registry, grants } = buildFakePrisma()

  const agentId = await ensureLibrarianAgent(prisma, ORG_A)
  await ensureLibrarianAgent(prisma, ORG_A)

  const grantedToolIds = new Set(registry.map((row) => row.toolId))
  assert.deepEqual(
    [...grantedToolIds].sort(),
    ['kb_list', 'kb_page_read', 'kb_search', 'send_message'].sort(),
  )

  // 4 tools granted once each, not doubled by the second ensure call.
  assert.equal(grants.length, 4)
  assert.ok(grants.every((grant) => grant.agentId === agentId && grant.state === 'allowed'))
})

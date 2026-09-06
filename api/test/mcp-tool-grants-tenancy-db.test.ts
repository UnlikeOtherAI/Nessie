import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { attachGrantsToRegistryEntries } from '../src/routes/mcp/tools.js'

/**
 * `ToolGrant` has no `organizationId` column, and the grant read used to lean
 * on the tool row's tenancy instead — "any grant whose `toolId` references a
 * row `listToolRegistry` returned is implicitly in-scope". That is false for
 * exactly the branch `listToolRegistry` deliberately supports: an
 * `organizationId: null` global tool is returned to every tenant, and every
 * tenant's grants hang off it. The owner-facing grant matrix therefore showed
 * another tenant's agent ids and grant configuration.
 *
 * Against Postgres, not a Prisma fake: the fake in `mcp-tools-route.test.ts`
 * filters on `toolId` alone and would report this fixed while the relation
 * clause did nothing.
 */

const dbTest = process.env.DATABASE_URL ? test : test.skip

type Seed = {
  globalToolId: string
  ownAgentId: string
  ownGrantId: string
  ownOrganizationId: string
  ownToolId: string
  foreignAgentId: string
  foreignGrantId: string
  foreignOrganizationId: string
  prisma: PrismaClient
}

const createOrganization = async (prisma: PrismaClient): Promise<string> => {
  const suffix = randomUUID().slice(0, 8)
  const organization = await prisma.organization.create({
    data: { name: `grant-tenancy-${suffix}` },
    select: { id: true },
  })
  return organization.id
}

const createAgent = async (prisma: PrismaClient, organizationId: string): Promise<string> => {
  const agent = await prisma.agent.create({
    data: { name: `grant-tenancy-agent-${randomUUID().slice(0, 8)}`, organizationId },
    select: { id: true },
  })
  return agent.id
}

const createTool = async (
  prisma: PrismaClient,
  organizationId: string | null,
): Promise<string> => {
  const slug = randomUUID().slice(0, 8)
  const entry = await prisma.toolRegistryEntry.create({
    data: {
      description: 'grant tenancy fixture',
      label: `Grant tenancy ${slug}`,
      organizationId,
      overview: 'grant tenancy fixture',
      scopeKey: `grant-tenancy:${slug}`,
      toolId: `grant_tenancy_${slug}`,
    },
    select: { id: true },
  })
  return entry.id
}

const seed = async (): Promise<Seed> => {
  const prisma = new PrismaClient()
  const ownOrganizationId = await createOrganization(prisma)
  const foreignOrganizationId = await createOrganization(prisma)
  const ownAgentId = await createAgent(prisma, ownOrganizationId)
  const foreignAgentId = await createAgent(prisma, foreignOrganizationId)
  // The global row `listToolRegistry` hands to every tenant.
  const globalToolId = await createTool(prisma, null)
  const ownToolId = await createTool(prisma, ownOrganizationId)

  const own = await prisma.toolGrant.create({
    data: { agentId: ownAgentId, source: 'agent_override', state: 'allowed', toolId: globalToolId },
    select: { id: true },
  })
  const foreign = await prisma.toolGrant.create({
    data: {
      agentId: foreignAgentId,
      source: 'agent_override',
      state: 'allowed',
      toolId: globalToolId,
    },
    select: { id: true },
  })

  return {
    globalToolId,
    ownAgentId,
    ownGrantId: own.id,
    ownOrganizationId,
    ownToolId,
    foreignAgentId,
    foreignGrantId: foreign.id,
    foreignOrganizationId,
    prisma,
  }
}

const registryRow = (id: string) =>
  ({ id }) as unknown as Parameters<typeof attachGrantsToRegistryEntries>[2][number]

dbTest('grants on a global tool are scoped to the calling tenant', async () => {
  const context = await seed()
  try {
    const attached = await attachGrantsToRegistryEntries(
      context.prisma,
      context.ownOrganizationId,
      [registryRow(context.globalToolId)],
    )

    const grantIds = attached[0]!.grants.map((grant) => grant.id)
    assert.deepEqual(grantIds, [context.ownGrantId])
    assert.ok(
      !grantIds.includes(context.foreignGrantId),
      'another tenant\'s grant on the same global tool must not be returned',
    )
  } finally {
    await context.prisma.$disconnect()
  }
})

dbTest('the other tenant sees its own grant on the same global tool', async () => {
  const context = await seed()
  try {
    const attached = await attachGrantsToRegistryEntries(
      context.prisma,
      context.foreignOrganizationId,
      [registryRow(context.globalToolId)],
    )

    assert.deepEqual(
      attached[0]!.grants.map((grant) => grant.id),
      [context.foreignGrantId],
    )
  } finally {
    await context.prisma.$disconnect()
  }
})

dbTest('a role grant is returned only for a tool the tenant owns', async () => {
  const context = await seed()
  try {
    const roleId = randomUUID()
    const onOwnTool = await context.prisma.toolGrant.create({
      data: { roleId, source: 'role', state: 'allowed', toolId: context.ownToolId },
      select: { id: true },
    })
    const onGlobalTool = await context.prisma.toolGrant.create({
      data: { roleId, source: 'role', state: 'allowed', toolId: context.globalToolId },
      select: { id: true },
    })

    const attached = await attachGrantsToRegistryEntries(
      context.prisma,
      context.ownOrganizationId,
      [registryRow(context.ownToolId), registryRow(context.globalToolId)],
    )
    const byTool = new Map(attached.map((entry) => [entry.id, entry.grants]))

    assert.deepEqual(
      byTool.get(context.ownToolId)!.map((grant) => grant.id),
      [onOwnTool.id],
    )
    // `roleId` is a free-form RBAC identifier with no row of its own, so a role
    // grant on a shared global tool carries no tenancy anyone can verify.
    assert.ok(
      !byTool.get(context.globalToolId)!.some((grant) => grant.id === onGlobalTool.id),
      'a role grant on a global tool belongs to no verifiable tenant',
    )
  } finally {
    await context.prisma.$disconnect()
  }
})

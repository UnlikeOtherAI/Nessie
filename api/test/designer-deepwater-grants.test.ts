import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import {
  fingerprintMcpToolDescriptor,
  isCurrentAllowedMcpToolGrant,
  mcpToolDescriptorAnnotationsFromMetadata,
} from '@nessie/mcp-manage'

import { setDeepWaterAgentAccess } from '../src/services/deepwater-agent-access.js'

const dbTest = process.env.DATABASE_URL ? test : test.skip

dbTest('DeepWater bundle atomically grants and revokes the descriptors the worker authorizes', async () => {
  const prisma = new PrismaClient()
  const organizationId = randomUUID()
  const userId = randomUUID()
  const agentId = randomUUID()
  const names = ['research_start', 'research_status', 'research_report', 'research_list', 'research_cancel']
  try {
    // Reuse the migration-owned public catalogue without mutating shared data.
    const product = await prisma.integratedProduct.findUniqueOrThrow({ where: { slug: 'deep-water' } })
    assert.ok(product.mcpCatalogEntryId)
    await prisma.organization.create({ data: { id: organizationId, name: 'Designer grant regression' } })
    await prisma.user.create({ data: { id: userId, displayName: 'Designer regression', email: `${userId}@designer.test` } })
    const project = await prisma.project.create({ data: { organizationId, name: 'Grant regression' } })
    const team = await prisma.team.create({ data: { projectId: project.id, name: 'Grant regression' } })
    await prisma.agent.create({
      data: { id: agentId, organizationId, projectId: project.id, teamId: team.id, name: 'CTO', role: 'assistant' },
    })
    const instance = await prisma.mcpServerInstance.create({
      data: {
        catalogEntryId: product.mcpCatalogEntryId,
        installedBy: userId,
        lifecycleState: 'active',
        organizationId,
        requiresExplicitToolGrant: true,
        scopeId: team.id,
        scopeType: 'team',
      },
    })
    const entries = await Promise.all(names.map((name) => prisma.toolRegistryEntry.create({
      data: {
        description: `Regression descriptor for ${name}`,
        handlerKind: 'mcp',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
        label: name,
        mcpInstanceId: instance.id,
        metadata: { requiresExplicitGrant: true },
        organizationId,
        overview: `Regression descriptor for ${name}`,
        scopeKey: instance.id,
        toolId: `mcp:${instance.id}:${name}`,
        transportConfig: { toolName: name },
      },
    })))
    const input = { agentId, organizationId, teamId: team.id }
    const fingerprint = (entry: typeof entries[number], index: number) => fingerprintMcpToolDescriptor({
      annotations: mcpToolDescriptorAnnotationsFromMetadata(entry.metadata),
      description: entry.description,
      inputSchema: entry.inputSchema,
      name: names[index]!,
      outputSchema: entry.outputSchema,
    })
    await prisma.toolRegistryEntry.update({ where: { id: entries[4]!.id }, data: { enabled: false } })
    await assert.rejects(setDeepWaterAgentAccess(prisma, { ...input, enabled: true }), /all six/)
    assert.equal(await prisma.toolGrant.count({ where: { agentId } }), 0, 'incomplete bundle grants nothing')
    await prisma.toolRegistryEntry.update({ where: { id: entries[4]!.id }, data: { enabled: true } })
    await setDeepWaterAgentAccess(prisma, { ...input, enabled: true })
    const grants = await prisma.toolGrant.findMany({ where: { agentId, roleId: null } })
    assert.equal(grants.length, 5)
    for (const [index, entry] of entries.entries()) {
      const grant = grants.find((row) => row.toolId === entry.id)
      assert.ok(grant)
      assert.equal(isCurrentAllowedMcpToolGrant(grant, fingerprint(entry, index)), true, names[index])
    }
    const configured = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })
    assert.equal((configured.toolPolicy as Record<string, boolean>).deep_water_run_update, true)

    const changed = await prisma.toolRegistryEntry.update({
      where: { id: entries[0]!.id }, data: { description: 'Changed security-relevant descriptor' },
    })
    assert.equal(isCurrentAllowedMcpToolGrant(grants.find((row) => row.toolId === changed.id)!, fingerprint(changed, 0)), false)
    await setDeepWaterAgentAccess(prisma, { ...input, enabled: true })
    const renewed = await prisma.toolGrant.findFirstOrThrow({ where: { agentId, toolId: changed.id, roleId: null } })
    assert.equal(isCurrentAllowedMcpToolGrant(renewed, fingerprint(changed, 0)), true)

    await setDeepWaterAgentAccess(prisma, { ...input, enabled: false })
    const denied = await prisma.toolGrant.findMany({ where: { agentId, roleId: null } })
    assert.equal(denied.length, 5, 'revocation leaves explicit tombstones against stale grants')
    assert.ok(denied.every((row) => row.state === 'denied'))
    const revoked = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })
    assert.notEqual((revoked.toolPolicy as Record<string, boolean>).deep_water_run_update, true)
  } finally {
    await prisma.toolGrant.deleteMany({ where: { agentId } })
    await prisma.agent.deleteMany({ where: { id: agentId } })
    await prisma.organization.deleteMany({ where: { id: organizationId } })
    await prisma.user.deleteMany({ where: { id: userId } })
    await prisma.$disconnect()
  }
})

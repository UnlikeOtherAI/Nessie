import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { Prisma, PrismaClient } from '@prisma/client'
import type { McpToolDescriptor } from '@nessie/mcp-client'
import {
  DEEP_WATER_LAUNCHER_TOOL_NAMES,
  deepWaterBriefTools,
  grantDeepWaterBundleInTransaction,
  loadDeepWaterPolicyKeys,
} from '@nessie/mcp-manage'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { runWithDeepWaterTransitionLock } from '../src/services/deepwater-activation.js'
import { setDeepWaterAgentAccess } from '../src/services/deepwater-agent-access.js'
import { projectDeepWaterTeamContract } from '../src/services/deepwater-projection.js'

/**
 * A real team with a DeepWater connector, its Personal Assistant and one
 * shared agent, for the PostgreSQL suites that exercise team transitions:
 * contract upgrades, disable, and the revocation guards.
 */

export const dbTest = process.env.DATABASE_URL ? test : test.skip

export const LEDGER_URL = 'https://8.8.8.8/v1/mcp/deepwater'
process.env.LEDGER_DEEPWATER_MCP_URL = LEDGER_URL
process.env.LEDGER_PROXY_TOKEN = 'nessie-ledger-app-api-key'
process.env.UOA_DOMAIN = 'api.nessie.works'
process.env.UOA_CONFIG_URL = 'https://api.nessie.works/api/auth/sso/config'
process.env.UOA_CONFIG_JWT_KID = 'nessie-test'
process.env.UOA_CONFIG_JWT_PRIVATE_KEY_B64 = Buffer.from('private-key').toString('base64')
process.env.UOA_CLIENT_SECRET = 'uoa-client-secret'

const descriptorsOf = (tools: ReadonlyArray<{
  name: string
  label: string
  description: string
  inputSchema?: Record<string, unknown>
}>): McpToolDescriptor[] =>
  tools.map((tool) => ({
    name: tool.name,
    title: tool.label,
    description: tool.description,
    inputSchema: tool.inputSchema ?? {},
  }))

/**
 * The launcher contract (manifest 0.2) a team may still project: its names are
 * the contract, so the schemas here are placeholders.
 */
export const launcherDescriptors = descriptorsOf(DEEP_WATER_LAUNCHER_TOOL_NAMES.map((name) => ({
  name,
  label: name,
  description: `Launcher contract ${name}`,
  inputSchema: { type: 'object' },
})))
/** The brief contract, which the manifest projects. */
export const briefDescriptors = descriptorsOf(deepWaterBriefTools)

export type Seed = {
  prisma: PrismaClient
  organizationId: string
  teamId: string
  userId: string
  personalAssistantId: string
  sharedAgentId: string
  instanceId: string
  cleanup: () => Promise<void>
}

export const seed = async (): Promise<Seed> => {
  const prisma = new PrismaClient()
  const organizationId = randomUUID()
  const userId = randomUUID()
  const personalAssistantId = randomUUID()
  const sharedAgentId = randomUUID()
  const product = await prisma.integratedProduct.findUniqueOrThrow({ where: { slug: 'deep-water' } })
  assert.ok(product.mcpCatalogEntryId, 'the migration links the first-party DeepWater catalog entry')
  await prisma.organization.create({ data: { id: organizationId, name: 'DeepWater contract upgrade' } })
  await prisma.user.create({ data: { id: userId, displayName: 'Owner', email: `${userId}@upgrade.test` } })
  const project = await prisma.project.create({ data: { organizationId, name: 'Upgrade' } })
  const team = await prisma.team.create({ data: { projectId: project.id, name: 'Upgrade' } })
  await prisma.agent.create({
    data: {
      id: personalAssistantId, organizationId, projectId: project.id, teamId: team.id,
      name: 'Personal Assistant', role: 'assistant', agentKind: 'personal_assistant', systemManaged: true,
      surfacePolicy: 'dm_only', delegationMode: 'act_as_requesting_user',
    },
  })
  await prisma.agent.create({
    data: { id: sharedAgentId, organizationId, projectId: project.id, teamId: team.id, name: 'Analyst', role: 'assistant' },
  })
  const instance = await prisma.mcpServerInstance.create({
    data: {
      catalogEntryId: product.mcpCatalogEntryId,
      installedBy: userId,
      lifecycleState: 'pending_setup',
      organizationId,
      scopeId: team.id,
      scopeType: 'team',
    },
  })
  await prisma.productTeamEnablement.create({
    data: { organizationId, teamId: team.id, productSlug: 'deep-water', enabled: true },
  })
  return {
    prisma,
    organizationId,
    teamId: team.id,
    userId,
    personalAssistantId,
    sharedAgentId,
    instanceId: instance.id,
    cleanup: async () => {
      await prisma.toolGrant.deleteMany({ where: { agentId: { in: [personalAssistantId, sharedAgentId] } } })
      await prisma.organization.deleteMany({ where: { id: organizationId } })
      await prisma.user.deleteMany({ where: { id: userId } })
      await prisma.$disconnect()
    },
  }
}

export const withSeed = (name: string, body: (s: Seed) => Promise<void>): void => {
  dbTest(name, async () => {
    const s = await seed()
    try {
      await body(s)
    } finally {
      await s.cleanup()
    }
  })
}

export const ownerContext = (s: Seed): AuthorizedActionContext =>
  ({
    actionContext: {},
    actor: { actorId: s.userId, actorType: 'user', roles: ['owner'] },
    tenant: { organizationId: s.organizationId },
  }) as unknown as AuthorizedActionContext

export const team = (s: Seed) => ({ organizationId: s.organizationId, teamId: s.teamId })

export const projectContract = (s: Seed, descriptors: McpToolDescriptor[], firstProvision = false) =>
  runWithDeepWaterTransitionLock(s.prisma, team(s), async (tx) => {
    const instance = await tx.mcpServerInstance.findUniqueOrThrow({ where: { id: s.instanceId } })
    return projectDeepWaterTeamContract(tx, {
      ...team(s),
      instance,
      firstProvision,
      descriptors,
      ledgerUrl: LEDGER_URL,
      credentialRef: 'LEDGER_PROXY_TOKEN',
    })
  })

export const registryIds = async (s: Seed): Promise<Map<string, string>> => {
  const rows = await s.prisma.toolRegistryEntry.findMany({
    where: { mcpInstanceId: s.instanceId },
    select: { id: true, transportConfig: true },
  })
  return new Map(rows.map((row) => [(row.transportConfig as { toolName: string }).toolName, row.id]))
}

export const legacyRun = (s: Seed, data: Partial<Prisma.ProductIntegrationRunUncheckedCreateInput>) =>
  s.prisma.productIntegrationRun.create({
    data: {
      organizationId: s.organizationId,
      teamId: s.teamId,
      productSlug: 'deep-water',
      requestedByUserId: s.userId,
      connectorId: s.instanceId,
      queryPreview: 'Legacy launcher research',
      ...data,
    },
  })

/**
 * A team still on the launcher contract whose Personal Assistant was granted
 * that whole bundle before the manifest moved to the brief contract.
 */
export const launcherTeam = async (s: Seed): Promise<Map<string, string>> => {
  assert.equal(await projectContract(s, launcherDescriptors, true), 'projected')
  await runWithDeepWaterTransitionLock(s.prisma, team(s), async (tx) => {
    const access = await loadDeepWaterPolicyKeys(tx, { ...team(s), contractToolNames: DEEP_WATER_LAUNCHER_TOOL_NAMES })
    assert.equal(access.configured, true)
    await grantDeepWaterBundleInTransaction(tx, { access, agentId: s.personalAssistantId, ...team(s) })
  })
  return registryIds(s)
}

/** A team on the manifest's brief contract whose Personal Assistant holds the whole bundle. */
export const briefTeam = async (s: Seed): Promise<Map<string, string>> => {
  assert.equal(await projectContract(s, briefDescriptors, true), 'projected')
  await setDeepWaterAgentAccess(s.prisma, { ...team(s), agentId: s.personalAssistantId, enabled: true })
  return registryIds(s)
}

export const policyOf = async (s: Seed, agentId: string): Promise<Record<string, boolean>> =>
  ((await s.prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).toolPolicy ?? {}) as Record<string, boolean>

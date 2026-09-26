import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { PrismaClient } from '@prisma/client'
import { listCloudBrowserConnections } from '@nessie/browser-cloud'
import { BUILTIN_TOOL_DEFINITIONS } from '@nessie/runtime'
import { AGENT_DESIGNER_BLUEPRINT } from '@nessie/team-admin'

import { createConsumedSourceSink } from '../src/run/execute/disclosure-basis.js'
import { runAccountConnectionsListTool } from '../src/run/pa-tools/account-connections.js'
import { authorizeToolCall } from '../src/run/tool-policy.js'
import type { BuiltinToolRuntimeContext } from '../src/run/tool-types.js'

const dbTest = process.env.DATABASE_URL ? test : test.skip

test('account discovery belongs to the PA and interactive Designer, never ordinary agents or unattended runs', () => {
  const id = 'account_connections_list'
  const enabled = new Set([id])
  assert.ok(AGENT_DESIGNER_BLUEPRINT.identityToolIds.includes(id))
  const gate = (kind: 'personal_assistant' | 'shared', liveRequester: boolean, delegated = false) =>
    authorizeToolCall(id, enabled, BUILTIN_TOOL_DEFINITIONS, null, null, kind, {
      identityToolIds: delegated ? enabled : new Set(), liveRequester,
    })
  assert.equal(gate('personal_assistant', true).allowed, true)
  assert.equal(gate('shared', true, true).allowed, true)
  assert.equal(gate('shared', true).allowed, false)
  assert.equal(gate('personal_assistant', false).allowed, false)
  assert.equal(gate('shared', false, true).allowed, false)
})

dbTest('saved team Browserbase and Kimi are discoverable with tenant, member, privacy and health boundaries', async () => {
  const prisma = new PrismaClient()
  const organizations = [randomUUID(), randomUUID()]
  const users = [randomUUID(), randomUUID()]
  const teams = [randomUUID(), randomUUID(), randomUUID()]
  const secretRefs: string[] = []
  const context = {
    actorContext: {
      actionContext: { requestId: randomUUID() },
      actor: { actorId: users[0]!, actorType: 'user', roles: ['owner'] },
      tenant: { organizationId: organizations[0]! },
    },
    channel: { id: randomUUID(), organizationId: organizations[0]!, teamId: randomUUID() },
    consumedSources: createConsumedSourceSink(),
    prisma, run: { interactive: true },
  } as unknown as BuiltinToolRuntimeContext
  try {
    await prisma.organization.createMany({ data: organizations.map((id) => ({ id, name: 'Connection test' })) })
    await prisma.user.createMany({ data: users.map((id) => ({
      id, email: `${id}@example.test`, displayName: 'Connection test',
    })) })
    await prisma.organizationMember.createMany({ data: organizations.flatMap((organizationId) =>
      users.map((userId) => ({ organizationId, userId, role: 'member' as const }))) })
    for (const [index, id] of teams.entries()) {
      const project = await prisma.project.create({ data: {
        name: 'Browser team', organizationId: organizations[index === 2 ? 1 : 0]!,
      } })
      await prisma.team.create({ data: { id, name: `Browser team ${index}`, projectId: project.id } })
    }
    await prisma.teamMember.create({ data: { teamId: teams[0]!, userId: users[0]! } })
    const addConnection = async (scope: 'team' | 'user' | 'organization', index: number, otherUser = false) => {
      const ref = `secret_browserbase_${randomUUID()}`
      secretRefs.push(ref)
      await prisma.mcpOAuthSecret.create({ data: { ref, authTag: 'tag', iv: 'iv', ciphertext: 'SECRET-CANARY' } })
      return prisma.cloudBrowserConnection.create({ data: {
        organizationId: organizations[index === 2 ? 1 : 0]!,
        scope, apiKeyRef: ref, createdByUserId: users[0]!,
        ...(scope === 'team' ? { teamId: teams[index]! } : {}),
        ...(scope === 'user' ? { userId: users[otherUser ? 1 : 0]! } : {}),
      } })
    }
    const ownTeam = await addConnection('team', 0)
    const otherTeam = await addConnection('team', 1)
    const foreign = await addConnection('team', 2)
    const org = await addConnection('organization', 0)
    const own = await addConnection('user', 0)
    const other = await addConnection('user', 0, true)
    const plan = await prisma.modelSubscription.create({ data: {
      organizationId: organizations[0]!, userId: users[0]!, provider: 'kimi',
      accountLabel: 'PRIVATE-LABEL-CANARY', providerAccountId: randomUUID(),
    } })
    await prisma.modelSubscription.create({ data: {
      organizationId: organizations[0]!, userId: users[1]!, provider: 'glm', providerAccountId: randomUUID(),
    } })
    const list = () => listCloudBrowserConnections(prisma, { organizationId: organizations[0]!, userId: users[0]! })
    const rows = await list()
    assert.deepEqual(new Set(rows.map((row) => row.id)), new Set([ownTeam.id, org.id, own.id]))
    assert.equal(rows.find((row) => row.id === ownTeam.id)?.teamId, teams[0])
    assert.doesNotMatch(JSON.stringify(rows), /apiKeyRef|SECRET-CANARY/)
    const output = (await runAccountConnectionsListTool(context)).outputPreview
    assert.match(output, /Browserbase: scope=team; status=active/)
    assert.match(output, /Kimi for Coding: status=active/)
    assert.match(output, /provider=subscription\/kimi; models=kimi-for-coding/)
    assert.match(output, /\/settings\/accounts\?tab=browsers/)
    assert.match(output, /\/settings\/accounts\?tab=ai/)
    assert.match(output, /\/admin\/connections/)
    assert.doesNotMatch(output, /\/settings\/account\?|\/settings\/organization|\/settings\/connections/)
    assert.doesNotMatch(output, /PRIVATE-LABEL-CANARY|SECRET-CANARY|GLM/)
    assert.deepEqual(context.consumedSources?.list(), [{ scopeType: 'user', scopeId: users[0] }])

    await prisma.organizationMember.update({
      where: { organizationId_userId: { organizationId: organizations[0]!, userId: users[0]! } },
      data: { role: 'owner' },
    })
    const ownerRows = await list()
    assert.ok(ownerRows.some((row) => row.id === otherTeam.id))
    assert.ok(!ownerRows.some((row) => row.id === other.id || row.id === foreign.id))
    await prisma.modelSubscription.update({ where: { id: plan.id }, data: { status: 'needs_reauthorization' } })
    const unhealthy = (await runAccountConnectionsListTool(context)).outputPreview
    assert.match(unhealthy, /Kimi for Coding: status=needs_reauthorization/)

    // A UOA-bound organisation without a live assertion cannot become a false empty directory.
    await prisma.organization.update({ where: { id: organizations[0]! }, data: { externalOrgId: randomUUID() } })
    const unreadable = (await runAccountConnectionsListTool(context)).outputPreview
    assert.match(unreadable, /Browserbase connections could not be read/)
    assert.doesNotMatch(unreadable, /No Browserbase connection/)
    assert.match(unreadable, /Kimi for Coding/)

    const brokenPlans = prisma.$extends({ query: { modelSubscription: {
      findMany: async () => { throw new Error('provider read canary') },
    } } })
    const partial = await runAccountConnectionsListTool({
      ...context, prisma: brokenPlans as unknown as PrismaClient,
    })
    assert.match(partial.outputPreview, /Personal model subscriptions could not be read/)
    assert.doesNotMatch(partial.outputPreview, /No personal model subscription|provider read canary/)

    await prisma.organizationMember.update({
      where: { organizationId_userId: { organizationId: organizations[0]!, userId: users[0]! } },
      data: { deactivatedAt: new Date() },
    })
    await assert.rejects(runAccountConnectionsListTool(context), /access.*not active/)
    const unattended = { ...context, run: { ...context.run, interactive: false } }
    await assert.rejects(runAccountConnectionsListTool(unattended), /live turn/)
  } finally {
    await prisma.organization.deleteMany({ where: { id: { in: organizations } } })
    await prisma.user.deleteMany({ where: { id: { in: users } } })
    await prisma.mcpOAuthSecret.deleteMany({ where: { ref: { in: secretRefs } } })
    await prisma.$disconnect()
  }
})

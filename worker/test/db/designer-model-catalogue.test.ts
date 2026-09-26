import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import {
  AGENT_DESIGNER_BLUEPRINT,
  ensureGlobalAgentBootstrap,
} from '@nessie/team-admin'

import { loadGlobalAgentCatalogueBlock } from '../../src/run/execute/global-agent-catalogue.js'
import type { RunContext } from '../../src/run/execute/types.js'
import { runAgentCreateTool } from '../../src/run/pa-tools/provisioning.js'
import type { BuiltinToolRuntimeContext } from '../../src/run/tool-types.js'
import { runDatabaseTest } from './support.js'

/**
 * The Designer sees the plans a person linked under Connected accounts.
 *
 * A person linked Kimi, asked the Designer to use it, and was told — after a
 * search of the connector library — that no such connector existed. The
 * catalogue the Designer is handed in its home DM read the Ledger catalogue
 * alone; the plan lived in `model_subscriptions`, which no Designer read ever
 * touched. Against real rows: the block the worker assembles for the home DM
 * lists the plan with the exact pair to pass, the shared-channel face (no
 * write verbs, advising everyone) does not, and `agent_create` takes the
 * pointer that tells two accounts at one provider apart.
 *
 * There is no Ledger key in this environment, so the deployment half of the
 * catalogue is unreadable here — which is also the case the block must get
 * right: "could not be read", never "no models", with the plan still listed.
 */

type Seed = {
  agentId: string
  homeChannelId: string
  organizationId: string
  ownerId: string
  projectId: string
  teamId: string
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const suffix = randomUUID()
  const owner = await prisma.user.create({
    data: { displayName: 'Owner', email: `designer-model-owner-${suffix}@example.test` },
  })
  const organization = await prisma.organization.create({
    data: { name: `designer-model-${suffix}` },
  })
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, role: 'owner', userId: owner.id },
  })
  const project = await prisma.project.create({
    data: { name: `designer-model-home-${suffix}`, organizationId: organization.id },
  })
  const team = await prisma.team.create({
    data: { name: `designer-model-team-${suffix}`, projectId: project.id },
  })
  await prisma.teamMember.create({
    data: { role: 'owner', teamId: team.id, userId: owner.id },
  })
  const bootstrap = await ensureGlobalAgentBootstrap(prisma, {
    blueprint: AGENT_DESIGNER_BLUEPRINT,
    organizationId: organization.id,
    teamId: team.id,
    userId: owner.id,
  })
  return {
    agentId: bootstrap.agentId,
    homeChannelId: bootstrap.channelId,
    organizationId: organization.id,
    ownerId: owner.id,
    projectId: project.id,
    teamId: team.id,
  }
}

const cleanup = async (prisma: PrismaClient, value: Seed): Promise<void> => {
  await prisma.organization.deleteMany({ where: { id: value.organizationId } })
  await prisma.user.deleteMany({ where: { id: value.ownerId } })
}

const linkKimi = async (prisma: PrismaClient, value: Seed, label: string): Promise<string> =>
  (await prisma.modelSubscription.create({
    data: {
      accountLabel: label,
      organizationId: value.organizationId,
      provider: 'kimi',
      providerAccountId: `kimi-${randomUUID()}`,
      userId: value.ownerId,
    },
  })).id

const actorContextFor = (value: Seed) => ({
  actionContext: {
    effectiveUserId: value.ownerId,
    requestId: `designer-model-${randomUUID()}`,
    teamId: value.teamId,
  },
  actor: { actorId: value.ownerId, actorType: 'user', roles: ['owner'] },
  tenant: {
    organizationId: value.organizationId,
    projectId: value.projectId,
    teamId: value.teamId,
  },
})

const runContextFor = (value: Seed): RunContext =>
  ({
    agent: { agentKind: 'shared', id: value.agentId, systemSlug: AGENT_DESIGNER_BLUEPRINT.slug },
    boundAgentIds: [],
    channel: {
      dmKey: null,
      id: value.homeChannelId,
      organizationId: value.organizationId,
      systemChannelType: 'system_agent',
    },
  }) as unknown as RunContext

const toolContextFor = (prisma: PrismaClient, value: Seed): BuiltinToolRuntimeContext =>
  ({
    actorContext: actorContextFor(value),
    agentId: value.agentId,
    agentKind: 'shared',
    channel: {
      id: value.homeChannelId,
      organizationId: value.organizationId,
      systemChannelType: 'system_agent',
    },
    ledgerIdentity: null,
    prisma,
    realtimeTransport: {} as BuiltinToolRuntimeContext['realtimeTransport'],
    run: {
      id: randomUUID(),
      interactive: true,
      messageId: randomUUID(),
      threadId: randomUUID(),
    },
    toolCallId: randomUUID(),
  }) as unknown as BuiltinToolRuntimeContext

const refusal = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected the tool to refuse')
}

runDatabaseTest('the home-DM catalogue lists the person\'s linked plan; the shared face does not', async (t) => {
  const prisma = new PrismaClient()
  const value = await seed(prisma)
  t.after(() => cleanup(prisma, value).then(() => prisma.$disconnect()))
  await linkKimi(prisma, value, 'sk-…a1b2')

  const home = await loadGlobalAgentCatalogueBlock(prisma, runContextFor(value), {
    actorContext: actorContextFor(value) as never,
    ledgerIdentity: null,
    resolvedToolIds: new Set(['agent_create', 'agent_update', 'agent_tool_access_set']),
  })
  assert.ok(home)
  assert.match(home, /This person's own linked plans \(1\) — a personal model connection, not a connector/)
  assert.match(home, /- provider subscription\/kimi, model kimi-for-coding — Kimi for Coding/)
  // No Ledger key here: the deployment half is unreadable and is said to be,
  // rather than reported as a deployment with no models.
  assert.match(home, /The deployment's model catalogue could not be read just now/)
  assert.doesNotMatch(home, /lists no selectable models/)

  // A shared room: the Designer advises everyone there and holds no write
  // verb, so whose plan is linked is not read at all.
  const shared = await loadGlobalAgentCatalogueBlock(prisma, runContextFor(value), {
    actorContext: actorContextFor(value) as never,
    ledgerIdentity: null,
    resolvedToolIds: new Set<string>(),
  })
  assert.ok(shared)
  assert.match(shared, /This person has linked no plan of their own/)
  assert.doesNotMatch(shared, /subscription\/kimi/)
})

runDatabaseTest('agent_create puts an agent on the named one of two linked accounts', async (t) => {
  const prisma = new PrismaClient()
  const value = await seed(prisma)
  t.after(() => cleanup(prisma, value).then(() => prisma.$disconnect()))
  const first = await linkKimi(prisma, value, 'sk-…a1b2')
  const second = await linkKimi(prisma, value, 'sk-…c3d4')
  const context = toolContextFor(prisma, value)

  // Two accounts at one provider: the validator refuses to guess between them.
  const message = await refusal(runAgentCreateTool(context, {
    model: 'kimi-for-coding',
    name: 'Pirate',
    provider: 'subscription/kimi',
  }))
  assert.match(message, /Choose which Kimi for Coding account/)

  const created = await runAgentCreateTool(context, {
    model: 'kimi-for-coding',
    modelSubscriptionId: second,
    name: 'Pirate',
    provider: 'subscription/kimi',
  })
  const agentId = /\]\(\/admin\/agents\/([0-9a-f-]{36})\)/.exec(created.outputPreview)?.[1]
  assert.ok(agentId, created.outputPreview)
  const agent = await prisma.agent.findUniqueOrThrow({
    where: { id: agentId },
    select: { model: true, modelSubscriptionId: true, ownerUserId: true, provider: true },
  })
  assert.equal(agent.provider, 'subscription/kimi')
  assert.equal(agent.model, 'kimi-for-coding')
  assert.equal(agent.modelSubscriptionId, second)
  assert.notEqual(agent.modelSubscriptionId, first)
  assert.equal(agent.ownerUserId, value.ownerId)
})

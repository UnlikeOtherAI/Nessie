import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { recomputeTokenLedgerCosts } from '@nessie/runtime'
import { parseOrganizationId, type AuthorizedActionContext } from '@nessie/schemas'

import { getLocalUsage } from '../src/services/local-usage.js'
import {
  modelServicePricingNeeded,
  writeModelServicePrices,
} from '../src/services/model-service-pricing.js'
import {
  createPricingProfile,
  deletePricingProfile,
  PricingProfileError,
} from '../src/services/pricing-profiles.js'

// Admin › Usage and limits reads named usage from the local ledger, and the
// model service's published prices are its default estimate. Both are raw SQL
// over the real tables, so they are proved against Postgres.

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

type Fixture = {
  agentIds: { mine: string; researcher: string }
  organizationId: string
  teamName: string
  userIds: { colleague: string; viewer: string }
}

const seed = async (prisma: PrismaClient): Promise<Fixture> => {
  const suffix = randomUUID()
  const organization = await prisma.organization.create({ data: { name: `usage ${suffix}` } })
  const project = await prisma.project.create({
    data: { name: `usage project ${suffix}`, organizationId: organization.id },
  })
  const teamName = `Design ${suffix.slice(0, 6)}`
  const team = await prisma.team.create({ data: { name: teamName, projectId: project.id } })
  const person = async (name: string, role: 'owner' | 'member') => {
    const user = await prisma.user.create({
      data: { displayName: name, email: `usage-${name.toLowerCase()}-${suffix}@example.test` },
    })
    await prisma.organizationMember.create({ data: { organizationId: organization.id, role, userId: user.id } })
    return user.id
  }
  const viewer = await person('Owner', 'owner')
  const colleague = await person('Colleague', 'member')
  const agent = async (name: string, visibility: 'team' | 'private', ownerUserId: string) =>
    (await prisma.agent.create({
      data: { name, organizationId: organization.id, ownerUserId, projectId: project.id, teamId: team.id, visibility },
    })).id
  const researcher = await agent('Researcher', 'team', colleague)
  const mine = await agent('My notes', 'private', viewer)
  const hiddenA = await agent('Hidden A', 'private', colleague)
  const hiddenB = await agent('Hidden B', 'private', colleague)

  const now = new Date()
  const event = (input: {
    agentId?: string
    billingSource?: 'ledger' | 'personal_subscription'
    cost: number | null
    occurredAt?: Date
    provider?: string
    model?: string
    teamId?: string | null
    total: number
    userId?: string | null
  }) => ({
    actorId: input.userId ?? 'system',
    agentId: input.agentId ?? null,
    billingSource: input.billingSource ?? 'ledger',
    estimatedCostAmount: input.cost,
    inputTokens: input.total,
    model: input.model ?? 'gpt-5-mini',
    occurredAt: input.occurredAt ?? now,
    operationType: 'chat' as const,
    organizationId: organization.id,
    outputTokens: 0,
    provider: input.provider ?? 'openai',
    requestId: randomUUID(),
    teamId: input.teamId === undefined ? team.id : input.teamId,
    totalTokens: input.total,
    userId: input.userId ?? null,
  })
  await prisma.tokenLedgerEvent.createMany({
    data: [
      event({ agentId: researcher, cost: 1, total: 1000, userId: colleague }),
      event({ agentId: mine, cost: 0.5, total: 500, userId: viewer }),
      event({ agentId: hiddenA, cost: null, total: 300, userId: colleague }),
      event({ agentId: hiddenB, cost: 0.2, total: 200, userId: colleague }),
      event({ cost: 0.1, teamId: null, total: 100 }),
      // A personal plan is never priced; its tokens are not "unpriced".
      event({ agentId: researcher, billingSource: 'personal_subscription', cost: null, total: 50, userId: colleague }),
      // Last year: outside every period below.
      event({
        agentId: researcher,
        cost: 9,
        occurredAt: new Date(Date.UTC(now.getUTCFullYear() - 1, 0, 2)),
        total: 9000,
        userId: colleague,
      }),
    ],
  })
  return {
    agentIds: { mine, researcher },
    organizationId: organization.id,
    teamName,
    userIds: { colleague, viewer },
  }
}

const cleanup = async (prisma: PrismaClient, fixture: Fixture) => {
  await prisma.tokenLedgerEvent.deleteMany({ where: { organizationId: fixture.organizationId } })
  await prisma.modelPricingProfile.deleteMany({ where: { organizationId: fixture.organizationId } })
  await prisma.agent.deleteMany({ where: { organizationId: fixture.organizationId } })
  await prisma.organization.deleteMany({ where: { id: fixture.organizationId } })
  await prisma.user.deleteMany({ where: { id: { in: Object.values(fixture.userIds) } } })
}

runDatabaseTest('usage is named, keeps other people\'s private agents nameless, and counts unpriced tokens', async () => {
  const prisma = new PrismaClient()
  const fixture = await seed(prisma)
  try {
    const byAgent = await getLocalUsage(prisma, {
      by: 'agent',
      organizationId: fixture.organizationId,
      period: 'month',
      viewerUserId: fixture.userIds.viewer,
    })
    assert.equal(byAgent.totalTokens, 2150)
    assert.ok(Math.abs(byAgent.estimatedCost - 1.8) < 1e-9)
    assert.equal(byAgent.unpricedTokens, 300)
    assert.equal(byAgent.rows[0]?.name, 'Researcher')
    assert.equal(byAgent.rows[0]?.totalTokens, 1050)
    const named = byAgent.rows.filter((row) => row.kind === 'named').map((row) => row.name).sort()
    assert.deepEqual(named, ['My notes', 'Researcher'])
    const folded = byAgent.rows.find((row) => row.kind === 'private_agents')
    assert.equal(folded?.count, 2)
    assert.equal(folded?.totalTokens, 500)
    assert.equal(folded?.unpricedTokens, 300)
    assert.equal(folded?.name, null)
    assert.equal(byAgent.rows.find((row) => row.kind === 'unattributed')?.totalTokens, 100)
    assert.doesNotMatch(JSON.stringify(byAgent), /Hidden/)

    const byTeam = await getLocalUsage(prisma, {
      by: 'team',
      organizationId: fixture.organizationId,
      period: 'year',
      viewerUserId: fixture.userIds.viewer,
    })
    assert.deepEqual(
      byTeam.rows.map((row) => [row.kind, row.name, row.totalTokens]),
      [['named', fixture.teamName, 2050], ['unattributed', null, 100]],
    )

    const byPerson = await getLocalUsage(prisma, {
      by: 'person',
      organizationId: fixture.organizationId,
      period: 'week',
      viewerUserId: fixture.userIds.viewer,
    })
    assert.deepEqual(
      byPerson.rows.map((row) => [row.kind, row.name, row.totalTokens]),
      [['named', 'Colleague', 1550], ['named', 'Owner', 500], ['unattributed', null, 100]],
    )
  } finally {
    await cleanup(prisma, fixture)
    await prisma.$disconnect()
  }
})

runDatabaseTest('published prices seed the estimate, leave owner prices alone, and re-price the past', async () => {
  const prisma = new PrismaClient()
  const fixture = await seed(prisma)
  const actorContext: AuthorizedActionContext = {
    actor: { actorId: fixture.userIds.viewer, actorType: 'user', roles: ['owner'] },
    actionContext: { requestId: 'published-prices' },
    tenant: { organizationId: parseOrganizationId(fixture.organizationId) },
  }
  try {
    assert.equal(await modelServicePricingNeeded(prisma, fixture.organizationId), true)

    await createPricingProfile(prisma, fixture.organizationId, {
      inputPerMillion: 3,
      modelPattern: 'claude',
      outputPerMillion: 15,
      provider: 'anthropic',
      source: 'manual',
    }, actorContext)
    await assert.rejects(
      createPricingProfile(prisma, fixture.organizationId, {
        modelPattern: 'gpt-5',
        provider: 'openai',
        source: 'provider-default',
      }, actorContext),
      (error: unknown) => error instanceof PricingProfileError && error.code === 'PRICING_SOURCE_RESERVED',
    )

    const published = [
      { cachedInputPerMillion: 0.025, inputPerMillion: 0.25, model: 'gpt-5-mini', outputPerMillion: 2, provider: 'openai' },
      { cachedInputPerMillion: null, inputPerMillion: 1.25, model: 'gpt-5', outputPerMillion: 10, provider: 'openai' },
      { cachedInputPerMillion: 0.3, inputPerMillion: 3.5, model: 'claude', outputPerMillion: 18, provider: 'anthropic' },
    ]
    assert.deepEqual(await writeModelServicePrices(prisma, fixture.organizationId, published), {
      added: 2, ownerPriced: 1, publishedModels: 3, updated: 0,
    })
    // Unchanged, even with more digits than the column keeps.
    assert.deepEqual(
      await writeModelServicePrices(prisma, fixture.organizationId, [
        { ...published[0]!, inputPerMillion: 0.250000001 },
        published[1]!,
      ]),
      { added: 0, ownerPriced: 0, publishedModels: 2, updated: 0 },
    )
    assert.deepEqual(
      await writeModelServicePrices(prisma, fixture.organizationId, [{ ...published[0]!, inputPerMillion: 0.3 }]),
      { added: 0, ownerPriced: 0, publishedModels: 1, updated: 1 },
    )
    const active = await prisma.modelPricingProfile.findMany({
      where: { effectiveTo: null, organizationId: fixture.organizationId },
      select: { inputPerMillion: true, modelPattern: true, source: true },
      orderBy: { modelPattern: 'asc' },
    })
    assert.deepEqual(
      active.map((row) => [row.modelPattern, row.source, row.inputPerMillion?.toNumber()]),
      [['claude', 'manual', 3], ['gpt-5', 'provider_default', 1.25], ['gpt-5-mini', 'provider_default', 0.3]],
    )

    // The ledger's one unpriced model-service event is valued now; the
    // personal plan's stays unpriced.
    const repriced = await recomputeTokenLedgerCosts(prisma, fixture.organizationId)
    assert.equal(repriced.updatedEvents, 1)
    const personal = await prisma.tokenLedgerEvent.findFirst({
      where: { billingSource: 'personal_subscription', organizationId: fixture.organizationId },
      select: { estimatedCostAmount: true },
    })
    assert.equal(personal?.estimatedCostAmount, null)
    assert.equal(await modelServicePricingNeeded(prisma, fixture.organizationId), false)

    // A model nobody has priced, used recently, asks for a refresh again.
    await prisma.tokenLedgerEvent.create({
      data: {
        actorId: 'system',
        estimatedCostAmount: null,
        model: 'brand-new',
        occurredAt: new Date(),
        operationType: 'chat',
        organizationId: fixture.organizationId,
        provider: 'mystery',
        requestId: randomUUID(),
        totalTokens: 10,
      },
    })
    assert.equal(await modelServicePricingNeeded(prisma, fixture.organizationId), true)

    const publishedRow = await prisma.modelPricingProfile.findFirstOrThrow({
      where: { effectiveTo: null, organizationId: fixture.organizationId, source: 'provider_default' },
      select: { id: true },
    })
    await assert.rejects(
      deletePricingProfile(prisma, publishedRow.id, fixture.organizationId, actorContext),
      (error: unknown) => error instanceof PricingProfileError && error.code === 'PRICING_PROFILE_PUBLISHED',
    )
  } finally {
    await cleanup(prisma, fixture)
    await prisma.$disconnect()
  }
})

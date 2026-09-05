import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient, type ChannelSystemType } from '@prisma/client'
import type { AuthorizedActionContext, WsScope } from '@nessie/schemas'
import Fastify from 'fastify'

import { createRequestHelpers } from '../src/lib/request-helpers.js'
import { registerAgentCardRoutes } from '../src/routes/agent-cards.js'
import type { RouteDeps } from '../src/routes/types.js'

/**
 * Who hears a card press.
 *
 * The press announces the response message, and that announcement is a
 * disclosure decision the destination owns: a delegated system DM — the
 * Personal Assistant's, or a global agent's home — is announced to its channel
 * alone, while an ordinary channel is announced organization-wide as well
 * (`buildChannelRealtimeScopes`,
 * `docs/standards/disclosure-boundaries.md`). The route used to build that pair
 * by hand and always include the organization scope, so pressing a card inside
 * a private assistant DM put the response preview — the values the person just
 * typed — on every connected member's socket.
 *
 * Database-backed rather than a Prisma fake on purpose: the fix is partly in
 * *what the card loader selects*, and a fake would happily hand back a
 * `systemChannelType` the real query never asked for.
 */

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

type Seed = {
  cardId: string
  channelId: string
  organizationId: string
  userId: string
}

const CARD_SPEC = {
  schemaVersion: 1,
  title: 'Ship the release?',
  blocks: [{ type: 'text', markdown: 'Everything is green.' }],
  actions: [{ key: 'approve', label: 'Approve', style: 'primary', submits: true }],
}

const seedCard = async (
  prisma: PrismaClient,
  suffix: string,
  channel: { systemChannelType: ChannelSystemType | null; type: 'dm' | 'standard' },
): Promise<Seed> => {
  const organization = await prisma.organization.create({
    data: { name: `card-scope-${suffix}` },
  })
  const project = await prisma.project.create({
    data: { name: `project-${suffix}`, organizationId: organization.id },
  })
  const team = await prisma.team.create({ data: { name: `team-${suffix}`, projectId: project.id } })
  const channelRow = await prisma.channel.create({
    data: {
      label: `channel-${suffix}`,
      organizationId: organization.id,
      projectId: project.id,
      slug: `card-scope-${suffix.slice(0, 8)}`,
      teamId: team.id,
      type: channel.type,
      ...(channel.systemChannelType ? { systemChannelType: channel.systemChannelType } : {}),
      visibility: 'private',
    },
  })
  const thread = await prisma.thread.create({
    data: { channelId: channelRow.id, title: 'main' },
  })
  const agent = await prisma.agent.create({
    data: {
      name: `agent-${suffix}`,
      organizationId: organization.id,
      projectId: project.id,
      teamId: team.id,
    },
  })
  const user = await prisma.user.create({
    data: { displayName: 'presser', email: `presser-${suffix}@example.test` },
  })
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, role: 'member', userId: user.id },
  })
  await prisma.channelMember.create({ data: { channelId: channelRow.id, userId: user.id } })

  const cardMessage = await prisma.message.create({
    data: {
      agentId: agent.id,
      content: 'Ship the release?',
      role: 'assistant',
      threadId: thread.id,
    },
  })
  const run = await prisma.run.create({
    data: { agentId: agent.id, status: 'completed', threadId: thread.id },
  })
  const card = await prisma.agentCard.create({
    data: {
      agentId: agent.id,
      channelId: channelRow.id,
      messageId: cardMessage.id,
      organizationId: organization.id,
      respondentUserIds: [],
      runId: run.id,
      spec: CARD_SPEC,
      status: 'open',
      threadId: thread.id,
    },
  })

  return {
    cardId: card.id,
    channelId: channelRow.id,
    organizationId: organization.id,
    userId: user.id,
  }
}

/** Scopes compared as a set: which audiences hear the press, not their order. */
const byKind = (scopes: WsScope[]): WsScope[] =>
  [...scopes].sort((left, right) => left.kind.localeCompare(right.kind))

/** Every scope set the press published, in order. */
const pressCard = async (prisma: PrismaClient, seed: Seed): Promise<WsScope[][]> => {
  const scopeSets: WsScope[][] = []
  const actorContext = {
    actionContext: { requestId: `card-scope-${seed.cardId}` },
    actor: { actorId: seed.userId, actorType: 'user', roles: ['member'] },
    tenant: { organizationId: seed.organizationId },
  } as unknown as AuthorizedActionContext

  const app = Fastify()
  registerAgentCardRoutes(app, {
    // The real rule, not a stand-in: this test is about the route reaching it.
    buildChannelRealtimeScopes: createRequestHelpers(prisma).buildChannelRealtimeScopes,
    dashboardCredentials: {},
    mcpSecretStore: {},
    messageMemoryCaptureConfig: null,
    prisma,
    realtimeHub: {
      publishWs: async (scopes: WsScope[]) => {
        scopeSets.push(scopes)
        return undefined
      },
    },
    requireActorContext: () => actorContext,
  } as unknown as RouteDeps & { dashboardCredentials: unknown })

  const response = await app.inject({
    method: 'POST',
    payload: { actionKey: 'approve' },
    url: `/api/agent-cards/${seed.cardId}/respond`,
  })
  assert.equal(response.statusCode, 200, response.body)
  await app.close()
  return scopeSets
}

const withSeed = async (
  t: test.TestContext,
  channel: { systemChannelType: ChannelSystemType | null; type: 'dm' | 'standard' },
  run: (prisma: PrismaClient, seed: Seed) => Promise<void>,
): Promise<void> => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  t.after(async () => {
    await prisma.organization.deleteMany({ where: { name: `card-scope-${suffix}` } })
    await prisma.user.deleteMany({ where: { email: { contains: suffix } } })
    await prisma.$disconnect()
  })
  await run(prisma, await seedCard(prisma, suffix, channel))
}

runDatabaseTest(
  'a card pressed in a personal-assistant DM announces to that channel only',
  async (t) => {
    await withSeed(
      t,
      { systemChannelType: 'personal_assistant', type: 'dm' },
      async (prisma, seed) => {
        const scopeSets = await pressCard(prisma, seed)
        assert.ok(scopeSets.length > 0, 'the press announced something')
        for (const scopes of scopeSets) {
          assert.deepEqual(byKind(scopes), [{ channelId: seed.channelId, kind: 'channel' }])
        }
      },
    )
  },
)

runDatabaseTest(
  'a card pressed in an ordinary channel still announces organization-wide',
  async (t) => {
    await withSeed(t, { systemChannelType: null, type: 'standard' }, async (prisma, seed) => {
      const scopeSets = await pressCard(prisma, seed)
      assert.ok(scopeSets.length > 0, 'the press announced something')
      for (const scopes of scopeSets) {
        assert.deepEqual(byKind(scopes), [
          { channelId: seed.channelId, kind: 'channel' },
          { kind: 'organization', organizationId: seed.organizationId },
        ])
      }
    })
  },
)

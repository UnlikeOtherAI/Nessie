import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { externalAgentDmKey } from '@nessie/team-admin'
import type { WsScope } from '@nessie/schemas'

import { runDeepSignalInsightFanout } from '../../src/control/deepsignal-insight.js'
import { runDatabaseTest } from './support.js'

/**
 * `deepsignal.insight.fanout` is safe to replay (audit 9.2,
 * docs/standards/horizontal-scaling.md § 3).
 *
 * The queue is at-least-once: a drain that drops an ack, a lease expiry or a
 * nack hands the same job to a second worker, and the fan-out's effect — a
 * digest message in a person's conversation, and the `message.new` that
 * interrupts them — is not one to repeat. The guarantee is in the write, not in
 * the enqueue key: `deliverInsightToDigest` takes a per-thread advisory lock and
 * answers an insight already recorded on a live digest with `duplicate`.
 *
 * So this runs the handler twice on one job's payload and asserts the effects
 * happen once.
 */

type Published = { scopes: WsScope[]; event: string }

const makeTransport = () => {
  const published: Published[] = []
  return {
    published,
    publishWs: async (scopes: WsScope[], input: { data: unknown; event: string }) => {
      published.push({ scopes, event: input.event })
      return undefined
    },
  }
}

type Seed = {
  channelId: string
  externalTeamId: string
  organizationId: string
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const suffix = randomUUID()
  const externalOrgId = `uoa-org-${suffix}`
  const externalTeamId = `uoa-team-${suffix}`

  const user = await prisma.user.create({
    data: { displayName: 'Signal reader', email: `ds-${suffix}@example.test` },
  })
  const organization = await prisma.organization.create({ data: { name: `ds-${suffix}` } })
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, role: 'owner', userId: user.id },
  })
  const project = await prisma.project.create({
    data: { name: `project-${suffix}`, organizationId: organization.id },
  })
  const team = await prisma.team.create({
    data: { externalOrgId, externalTeamId, name: `team-${suffix}`, projectId: project.id },
  })
  await prisma.teamMember.create({ data: { teamId: team.id, userId: user.id } })
  await prisma.productTeamEnablement.create({
    data: {
      enabled: true,
      externalOrgId,
      externalTeamId,
      organizationId: organization.id,
      productSlug: 'deepsignal',
      teamId: team.id,
    },
  })
  await prisma.productAccountLink.create({
    data: {
      organizationId: organization.id,
      productSlug: 'deepsignal',
      status: 'linked',
      uoaSub: `uoa-sub-${suffix}`,
      userId: user.id,
    },
  })
  const channel = await prisma.channel.create({
    data: {
      dmKey: externalAgentDmKey('deepsignal', organization.id, user.id, externalTeamId),
      label: 'DeepSignal',
      organizationId: organization.id,
      projectId: project.id,
      systemChannelType: 'external_agent',
      teamId: team.id,
      type: 'dm',
      visibility: 'private',
    },
  })

  return { channelId: channel.id, externalTeamId, organizationId: organization.id }
}

runDatabaseTest('replaying an insight fan-out delivers the digest once', async () => {
  const prisma = new PrismaClient()
  const context = await seed(prisma)
  const transport = makeTransport()
  const insightId = `insight-${randomUUID()}`
  const job = {
    insightId,
    organizationId: context.organizationId,
    payload: {
      brief: { kind: 'risk', whatChanged: 'A competitor changed pricing' },
      event: 'insight.surfaced',
      insightId,
      teamId: context.externalTeamId,
    },
  }

  try {
    const first = await runDeepSignalInsightFanout(
      { prisma, realtimeTransport: transport },
      job,
    )
    assert.equal(first.deliveries.length, 1, 'the linked member is reached')
    assert.equal(first.deliveries[0]?.mode, 'posted')

    // The job is claimed a second time — a dropped ack, a lease expiry, a nack.
    const replay = await runDeepSignalInsightFanout(
      { prisma, realtimeTransport: transport },
      job,
    )
    assert.equal(replay.deliveries[0]?.mode, 'duplicate', 'the replay recognises the insight')
    assert.equal(
      replay.deliveries[0]?.messageId,
      first.deliveries[0]?.messageId,
      'and answers with the digest it already wrote',
    )

    const messages = await prisma.message.findMany({
      where: { thread: { channelId: context.channelId } },
      select: { id: true, metadata: true },
    })
    assert.equal(messages.length, 1, 'two runs of the job leave one digest message')

    const recorded = (
      (messages[0]?.metadata as { external?: { insights?: { insightId: string }[] } })
        ?.external?.insights ?? []
    ).map((entry) => entry.insightId)
    assert.deepEqual(recorded, [insightId], 'the insight is recorded once, not twice')

    assert.equal(
      transport.published.filter((entry) => entry.event === 'message.new').length,
      1,
      'the person is interrupted once',
    )
  } finally {
    await prisma.organization.delete({ where: { id: context.organizationId } })
    await prisma.$disconnect()
  }
})

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import type { AuthorizedActionContext } from '@nessie/schemas'

import { resolveDeepWaterResearchReadiness } from '../src/services/deepwater-research-readiness.js'
import { RUNS, drafted, open, withBriefApi, type BriefApiFixture } from './deepwater-research-runs-fixture.js'

/**
 * Where a person's brief may come from, what they are told when it cannot be
 * opened, and their Retry of a blocked delivery (Water plan nessie.md §7.1,
 * amendments N3, N7): a brief lives in a conversation its person can post in,
 * in its own team, and a private room is theirs to research from; a person is
 * told the same first remedy whichever surface asks; and only the requester
 * retries a delivery, once per actionId.
 */

const briefCount = (fixture: BriefApiFixture) =>
  fixture.prisma.productIntegrationRun.count({ where: { organizationId: fixture.ids.organization } })

const room = async (
  fixture: BriefApiFixture,
  input: { teamId?: string; visibility?: 'public' | 'private'; archived?: boolean; members?: string[] } = {},
) => {
  const channel = await fixture.prisma.channel.create({
    data: {
      label: 'room',
      slug: `room-${randomUUID()}`,
      organizationId: fixture.ids.organization,
      projectId: fixture.ids.project,
      teamId: input.teamId ?? fixture.ids.team,
      visibility: input.visibility ?? 'public',
      ...(input.archived ? { archivedAt: new Date() } : {}),
    },
  })
  for (const userId of input.members ?? []) {
    await fixture.prisma.channelMember.create({ data: { channelId: channel.id, userId } })
  }
  const thread = await fixture.prisma.thread.create({ data: { channelId: channel.id } })
  return { channelId: channel.id, threadId: thread.id }
}

const from = (origin: { channelId: string; threadId: string; rootMessageId?: string }) =>
  ({ origin: { kind: 'thread', ...origin } })

withBriefApi('a brief is opened only from a conversation its person can post in, in its own team', async (fixture) => {
  const otherTeam = await fixture.prisma.team.create({ data: { name: 'Elsewhere', projectId: fixture.ids.project } })
  const elsewhere = await open(fixture, from(await room(fixture, { teamId: otherTeam.id })))
  assert.equal(elsewhere.response.statusCode, 409)
  assert.equal(elsewhere.response.body.error?.code, 'DEEP_WATER_TEAM_MISMATCH')

  const archived = await open(fixture, from(await room(fixture, { archived: true })))
  assert.equal(archived.response.statusCode, 403)
  assert.equal(archived.response.body.error?.code, 'DEEP_WATER_BRIEF_THREAD_FORBIDDEN')

  // A private room the person is not in does not exist for them.
  const closed = await open(fixture, from(await room(fixture, { visibility: 'private', members: [fixture.ids.colleague] })))
  assert.equal(closed.response.statusCode, 404)
  assert.equal(closed.response.body.error?.code, 'THREAD_NOT_FOUND')

  const mismatched = await open(fixture, from({ channelId: (await room(fixture)).channelId, threadId: fixture.ids.thread }))
  assert.equal(mismatched.response.statusCode, 404)

  const root = await fixture.prisma.message.create({
    data: { threadId: fixture.ids.thread, userId: fixture.ids.requester, role: 'user', content: 'The question' },
  })
  const reply = await fixture.prisma.message.create({
    data: {
      threadId: fixture.ids.thread, userId: fixture.ids.requester, role: 'user', content: 'A reply', rootMessageId: root.id,
    },
  })
  const underReply = await open(fixture, from({ channelId: fixture.ids.channel, threadId: fixture.ids.thread, rootMessageId: reply.id }))
  assert.equal(underReply.response.statusCode, 404, 'a card goes under a root message, never a reply')
  assert.equal(await briefCount(fixture), 0, 'no refusal writes a brief')

  const underRoot = await open(fixture, from({ channelId: fixture.ids.channel, threadId: fixture.ids.thread, rootMessageId: root.id }))
  assert.equal(underRoot.response.statusCode, 202)
  assert.equal((underRoot.response.body.data?.origin as { rootMessageId: string }).rootMessageId, root.id)
})

withBriefApi('a person may research from their own private room, and the brief lives in that thread', async (fixture) => {
  // A shared agent there is refused every DeepWater tool (N7); the person's own brief is the way.
  const privateRoom = await room(fixture, { visibility: 'private', members: [fixture.ids.requester] })
  const { response, runId } = await open(fixture, from(privateRoom))
  assert.equal(response.statusCode, 202)
  const run = await fixture.prisma.productIntegrationRun.findUniqueOrThrow({ where: { id: runId } })
  assert.equal(run.channelId, privateRoom.channelId)
  assert.equal(run.threadId, privateRoom.threadId)
  assert.deepEqual(run.sourceScopes, [{ scopeType: 'channel', scopeId: privateRoom.channelId }])
  assert.deepEqual(run.disclosureSources, [{ sourceChannelId: privateRoom.channelId, sourceAuthorUserId: fixture.ids.requester }])
})

withBriefApi('a person is told the first remedy, whichever surface asks', async (fixture) => {
  await fixture.prisma.productTeamEnablement.updateMany({
    where: { organizationId: fixture.ids.organization },
    data: { enabled: false },
  })
  // The colleague has no DeepWater link either, but the team switch comes first.
  fixture.actAs('colleague')
  const refused = await open(fixture)
  assert.equal(refused.response.statusCode, 409)
  assert.deepEqual(refused.response.body.error?.details, { reason: 'team_off' })
  const readiness = await resolveDeepWaterResearchReadiness(fixture.prisma, {
    actionContext: { requestId: 'readiness', teamId: fixture.ids.team },
    actor: { actorId: fixture.ids.colleague, actorType: 'user', roles: ['member'] },
    tenant: { organizationId: fixture.ids.organization, teamId: fixture.ids.team },
  } as unknown as AuthorizedActionContext, { teamId: fixture.ids.team, ledgerIdentity: { requestHeaders: async () => ({}) } })
  assert.equal(readiness.state, 'team_off')
})

withBriefApi('only the requester retries a blocked delivery, once per actionId', async (fixture) => {
  const { runId } = await open(fixture)
  await drafted(fixture, runId)
  const deliver = (actionId: string = randomUUID()) =>
    fixture.request('POST', `${RUNS}/${runId}/deliver`, { actionId })

  await fixture.prisma.productIntegrationRun.update({ where: { id: runId }, data: { status: 'running' } })
  const unblocked = await deliver()
  assert.equal(unblocked.statusCode, 409)
  assert.equal(unblocked.body.error?.code, 'DEEP_WATER_DELIVERY_NOT_BLOCKED')

  await fixture.prisma.productIntegrationRun.update({
    where: { id: runId },
    data: { deliveryBlockedReason: 'ledger_unavailable' },
  })
  fixture.actAs('colleague') // sees the launched research in the room, but it is not addressed to them
  assert.equal((await deliver()).body.error?.code, 'DEEP_WATER_DELIVERY_NOT_BLOCKED')

  fixture.actAs('requester')
  const actionId = randomUUID()
  const retried = await deliver(actionId)
  assert.equal(retried.statusCode, 202)
  assert.equal((retried.body.data?.delivery as { state: string }).state, 'pending')
  const jobs = () => fixture.prisma.$queryRawUnsafe<Array<{ payload: Record<string, unknown> }>>(
    `SELECT payload FROM queue_jobs WHERE topic = 'deep_water.run.deliver' AND payload->>'runId' = $1`,
    runId,
  )
  const [job] = await jobs()
  assert.deepEqual(job?.payload.identity, fixture.identity)
  assert.equal((await deliver(actionId)).statusCode, 200, 'a lost answer retried is a replay')
  assert.equal((await jobs()).length, 1)
})

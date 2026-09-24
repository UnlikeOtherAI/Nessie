import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { PROJECT_OPERATOR_TOOL_IDS } from '@nessie/runtime'
import { TICKET_WORK_PURPOSE } from '@nessie/schemas'

import {
  projectOperatorRunInputOfJob,
  resolveRunProjectOperatorToolIds,
} from '../../src/run/project-operator-admission.js'
import { runProjectCreateTool, runProjectListTool } from '../../src/run/pa-tools/team-structure.js'
import type { BuiltinToolRuntimeContext } from '../../src/run/tool-types.js'
import {
  ARM_REFUSAL,
  LIVE_TURN_REFUSAL,
  operatorContext,
  postMessage,
  refusal,
  seedProjectOperatorWorld,
  type ProjectOperatorWorld,
  type TurnShape,
} from './project-operator-fixture.js'
import { runDatabaseTest } from './support.js'

/**
 * The project-operator arm's two locks against real rows
 * (docs/standards/personal-assistant-tools.md → "The project-operator
 * capability"): run setup admits the verbs only on a live person's own turn in
 * a project room the CTO is bound to, and every verb refuses the same shapes
 * again at the call. Each shape is one the review found could make somebody
 * else's input look like the person's own turn.
 *
 * Cleanup is scoped to this suite's own organisation.
 */

/** Run setup's answer for the run a context names. */
const admission = (prisma: PrismaClient, context: BuiltinToolRuntimeContext, toolPolicy = { project_operator: true }) =>
  resolveRunProjectOperatorToolIds(prisma, {
    ...projectOperatorRunInputOfJob({
      actorContext: context.actorContext,
      ...(context.run.batchMessageIds ? { batchMessageIds: [...context.run.batchMessageIds] } : {}),
      interactive: context.run.interactive === true,
      messageId: context.run.messageId,
      ...(context.run.resumedByUserId ? { resumedByUserId: context.run.resumedByUserId } : {}),
    }, {
      agentId: context.agentId,
      channelId: context.channel.id,
      organizationId: context.channel.organizationId,
      runId: context.run.id,
      threadId: context.run.threadId,
    }),
    toolPolicy,
  })

/** Both locks refuse the shape, and nothing is written. */
const assertShut = async (
  prisma: PrismaClient,
  s: ProjectOperatorWorld,
  name: string,
  context: BuiltinToolRuntimeContext,
  expected: RegExp,
) => {
  assert.equal((await admission(prisma, context)).size, 0, `${name}: admitted at run setup`)
  const projectName = `Sneaky ${randomUUID()}`
  assert.match(await refusal(runProjectCreateTool(context, { name: projectName, teamId: s.teamId })), expected, name)
  assert.equal(await prisma.project.count({ where: { name: projectName } }), 0, `${name}: wrote a project`)
}

runDatabaseTest('the arm opens on a person\'s own turn, and on their own Continue, Restart and drain', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedProjectOperatorWorld(prisma)
  t.after(() => s.cleanup().then(() => prisma.$disconnect()))

  const own = await operatorContext(prisma, s, s.ownerId)
  assert.deepEqual([...await admission(prisma, own)], [...PROJECT_OPERATOR_TOOL_IDS])
  // Their own press of their own stopped turn.
  for (const shape of [
    { continuationOf: true, resumedByUserId: s.ownerId },
    { restartOf: true, resumedByUserId: s.ownerId },
  ] as const) {
    const context = await operatorContext(prisma, s, s.ownerId, shape)
    assert.equal((await admission(prisma, context)).size, PROJECT_OPERATOR_TOOL_IDS.size, JSON.stringify(shape))
  }
  // A drain of their own messages.
  const thread = (await prisma.thread.create({ data: { channelId: s.engId }, select: { id: true } })).id
  const earlier = await postMessage(prisma, thread, { userId: s.ownerId })
  const drained = await operatorContext(prisma, s, s.ownerId, { batch: [earlier.id], threadId: thread })
  assert.equal((await admission(prisma, drained)).size, PROJECT_OPERATOR_TOOL_IDS.size)
  await runProjectListTool(drained, {})
})

runDatabaseTest('no unattended run and nobody else\'s input opens the arm, at setup or at the call', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedProjectOperatorWorld(prisma)
  t.after(() => s.cleanup().then(() => prisma.$disconnect()))
  const thread = async () => (await prisma.thread.create({ data: { channelId: s.engId }, select: { id: true } })).id

  // A run with nobody to act as says so in its own words.
  await assertShut(prisma, s, 'a trigger fire', await operatorContext(prisma, s, s.ownerId, { actorType: 'agent' }),
    /requires a user actor context/)
  await assertShut(prisma, s, 'ticket work', await operatorContext(prisma, s, s.ownerId, {
    actorType: 'agent', purpose: TICKET_WORK_PURPOSE,
  }), /acts for a person, and ticket work has none behind it/)
  // A person rides along, but nobody is asking right now.
  const shapes: Array<[string, TurnShape]> = [
    ['a scheduled fire that reconstructs its creator', { actorType: 'agent', effectiveUserId: s.ownerId, interactive: false }],
    ['a worker continuation of a long turn', { interactive: false }],
    ['ticket work that somehow carries a person', { purpose: TICKET_WORK_PURPOSE }],
    ['a peer delegation', { purpose: 'agent.peer_delegation' }],
    ['channel-policy work', { purpose: 'channel.policy' }],
    ['another person\'s identity riding along', { effectiveUserId: s.memberId }],
  ]
  for (const [name, shape] of shapes) {
    await assertShut(prisma, s, name, await operatorContext(prisma, s, s.ownerId, shape), LIVE_TURN_REFUSAL)
  }

  // The owner restarting a failed webhook, cron or ticket-work run: the
  // replayed input is the trigger's kickoff, not anything the owner wrote.
  const firedIn = await thread()
  const kickoff = await postMessage(prisma, firedIn, { authoredByPerson: false, role: 'system', userId: null })
  await assertShut(prisma, s, 'a Restart of a trigger fire', await operatorContext(prisma, s, s.ownerId, {
    messageId: kickoff.id, restartOf: true, resumedByUserId: s.ownerId, threadId: firedIn,
  }), LIVE_TURN_REFUSAL)
  // B restarting, or continuing, A's run.
  const asked = await thread()
  const members = await postMessage(prisma, asked, { userId: s.memberId })
  for (const replay of [{ restartOf: true }, { continuationOf: true }] as const) {
    await assertShut(prisma, s, `somebody else's ${JSON.stringify(replay)}`, await operatorContext(prisma, s, s.ownerId, {
      ...replay, messageId: members.id, resumedByUserId: s.ownerId, threadId: asked,
    }), LIVE_TURN_REFUSAL)
  }
  // A card or approval the member answered resumes as the owner who parked it.
  await assertShut(prisma, s, 'a card somebody else answered', await operatorContext(prisma, s, s.ownerId, {
    continuationOf: true, resumedByUserId: s.memberId,
  }), LIVE_TURN_REFUSAL)
  // A drain takes its latest person's actor while folding in others' messages.
  const shared = await thread()
  const theirs = await postMessage(prisma, shared, { userId: s.memberId })
  await assertShut(prisma, s, 'a drain that folded in another member\'s message', await operatorContext(prisma, s, s.ownerId, {
    batch: [theirs.id], threadId: shared,
  }), LIVE_TURN_REFUSAL)
  // A post relayed as the person (a delegate's send_message) is not their composer message.
  const relayedIn = await thread()
  const relayed = await postMessage(prisma, relayedIn, { authoredByPerson: false, userId: s.ownerId })
  await assertShut(prisma, s, 'a relayed post', await operatorContext(prisma, s, s.ownerId, {
    messageId: relayed.id, threadId: relayedIn,
  }), LIVE_TURN_REFUSAL)
})

runDatabaseTest('the arm opens only in a live project room the agent is bound to, while the grant and switch stand', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedProjectOperatorWorld(prisma)
  t.after(() => s.cleanup().then(() => prisma.$disconnect()))

  const rooms: Array<[string, string]> = [
    // A real room of the project, by a real person, that the CTO is not in.
    ['a room it is not bound to', s.unboundId],
    ['an organisation-wide channel', s.orgWideId],
    ['a DM', s.dmId],
    ['a system conversation', s.systemId],
  ]
  for (const [name, channelId] of rooms) {
    await assertShut(prisma, s, name, await operatorContext(prisma, s, s.ownerId, { channelId }), ARM_REFUSAL)
  }
  const archived = await operatorContext(prisma, s, s.ownerId)
  await prisma.channel.update({ where: { id: s.engId }, data: { archivedAt: new Date() } })
  await assertShut(prisma, s, 'an archived room', archived, ARM_REFUSAL)
  await prisma.channel.update({ where: { id: s.engId }, data: { archivedAt: null } })

  // The organisation switches the capability off after the run began.
  const switched = await operatorContext(prisma, s, s.ownerId)
  assert.equal((await admission(prisma, switched)).size, PROJECT_OPERATOR_TOOL_IDS.size)
  await prisma.toolRegistryEntry.upsert({
    where: {
      organizationId_scopeKey_toolId: { organizationId: s.organizationId, scopeKey: 'builtin', toolId: 'project_operator' },
    },
    create: {
      builtin: true, description: 'x', enabled: false, handlerKind: 'builtin', label: 'Project operator',
      organizationId: s.organizationId, overview: 'x', safe: false, scopeKey: 'builtin', toolId: 'project_operator',
    },
    update: { enabled: false },
  })
  await assertShut(prisma, s, 'the capability switched off', switched, ARM_REFUSAL)
  await prisma.toolRegistryEntry.updateMany({
    where: { organizationId: s.organizationId, toolId: 'project_operator' },
    data: { enabled: true },
  })

  // The grant taken back after the run began.
  const revoked = await operatorContext(prisma, s, s.ownerId)
  await prisma.agent.update({ where: { id: s.ctoId }, data: { toolPolicy: {} } })
  assert.match(await refusal(runProjectListTool(revoked, {})), ARM_REFUSAL)
})

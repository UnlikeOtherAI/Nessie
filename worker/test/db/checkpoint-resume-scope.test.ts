import assert from 'node:assert/strict'

import { startRoomHarness, type Room, type RoomHarness } from './room-run-harness.js'
import { runDatabaseTest } from './support.js'

// Who may pick up the saved work of a run that stopped at a budget ceiling.
//
// The worker auto-loads a checkpoint by conversation — the newest unconsumed
// one in the run's thread and reply root — so that a plain "keep going" reply
// resumes it. In a shared room the next run in that conversation can be
// anything: the agent's own schedule, another agent, another member's
// question. Each used to claim the checkpoint first and ask afterwards whether
// it could read it (docs/standards/tech-and-run-budgets.md → "Three kinds of
// checkpoint", docs/standards/disclosure-boundaries.md).
//
// Every run here goes through the real run executor with the mock provider;
// the checkpoint is written by the real `persistRunCheckpoint`.

const NOTE = 'Compared four of the six vendors; Acme and Globex remain, pricing pages bookmarked.'

type Fixture = Room & { aliceId: string; bobId: string; planningId: string }

// Alice asked the agent in the room; it answered in the room itself and
// stopped at its token limit, leaving its working notes. `restricted` stamps
// them with the private planning room Alice drew on — which the schedule's
// owner is also in, and Bob is not.
const seedStoppedRun = async (
  harness: RoomHarness,
  s: Fixture,
  input: { agentId?: string; restricted: boolean },
): Promise<string> => {
  const { prisma } = harness
  const { persistRunCheckpoint } = await import('../../src/run/execute/checkpoint.js')
  const agentId = input.agentId ?? s.agentId
  const asked = await prisma.message.create({
    data: { content: 'Which vendor should we pick?', role: 'user', threadId: s.roomThreadId, userId: s.aliceId },
  })
  const run = await prisma.run.create({
    data: {
      agentId,
      finishedAt: new Date(),
      replyPlacement: 'channel',
      status: 'completed',
      threadId: s.roomThreadId,
      triggerMessageId: asked.id,
    },
  })
  const task = await prisma.task.create({
    data: { agentId, organizationId: s.organizationId, projectId: s.projectId, runId: run.id, title: 'vendors' },
  })
  return persistRunCheckpoint(prisma, {
    agentId,
    basis: input.restricted ? [{ scopeId: s.planningId, scopeType: 'channel' }] : [],
    disclosureSources: input.restricted ? [{ sourceAuthorUserId: s.aliceId, sourceChannelId: s.planningId }] : [],
    generation: 1,
    note: NOTE,
    organizationId: s.organizationId,
    reason: 'token_limit',
    rootMessageId: null,
    runId: run.id,
    sources: [],
    taskId: task.id,
    threadId: s.roomThreadId,
  })
}

runDatabaseTest('a checkpoint in a shared room', async (t) => {
  const harness = await startRoomHarness()
  t.after(harness.close)
  const { ask, fire, prisma, readableBy } = harness

  const withFixture = async (
    st: { after: (fn: () => Promise<void>) => void },
    body: (s: Fixture) => Promise<void>,
  ): Promise<void> => {
    const room = await harness.seedRoom(st, ['Ondrej', 'Alice', 'Bob'])
    const planning = await prisma.channel.create({
      data: {
        label: 'planning',
        organizationId: room.organizationId,
        projectId: room.projectId,
        slug: `planning-${room.roomId.slice(0, 8)}`,
        teamId: room.teamId,
        type: 'standard',
        visibility: 'private',
      },
    })
    await prisma.channelMember.createMany({
      data: [room.ownerId, room.people['Alice']!].map((userId) => ({ channelId: planning.id, userId })),
    })
    await body({ ...room, aliceId: room.people['Alice']!, bobId: room.people['Bob']!, planningId: planning.id })
  }

  const consumedBy = async (checkpointId: string): Promise<string | null> =>
    (await prisma.runCheckpoint.findUniqueOrThrow({ where: { id: checkpointId } })).consumedByRunId

  // Alice keeps going in the conversation the notes came from.
  const aliceContinues = (s: Fixture) => ask(s, {
    asUserId: s.aliceId,
    question: 'Keep going, please.',
    replyPlacement: 'channel',
    text: 'Picking up from Acme and Globex.',
  })

  await t.test('the agent\'s own schedule leaves a person\'s checkpoint to them', async (st) => {
    await withFixture(st, async (s) => {
      const checkpointId = await seedStoppedRun(harness, s, { restricted: false })

      const joke = await fire(s, 'Why did the math book look sad? It had too many problems.')
      assert.ok(!joke.sent.includes(NOTE), 'the schedule is not handed Alice\'s working notes')
      assert.equal(await consumedBy(checkpointId), null, 'the schedule does not consume them')

      const resumed = await aliceContinues(s)
      assert.ok(resumed.sent.includes(NOTE), 'Alice\'s "keep going" still resumes her work')
      assert.equal(await consumedBy(checkpointId), resumed.runId)
    })
  })

  await t.test('a restricted checkpoint the schedule\'s owner may read does not restrict the post', async (st) => {
    await withFixture(st, async (s) => {
      const checkpointId = await seedStoppedRun(harness, s, { restricted: true })

      const joke = await fire(s, 'Why don\'t scientists trust atoms? Because they make up everything.')
      assert.equal(await consumedBy(checkpointId), null)
      assert.deepEqual(joke.posted.basisScopes, [])
      assert.equal(await readableBy(s, s.bobId, joke.posted), true)
    })
  })

  await t.test('a member who may not read a checkpoint leaves it for one who may', async (st) => {
    await withFixture(st, async (s) => {
      const checkpointId = await seedStoppedRun(harness, s, { restricted: true })

      const bobs = await ask(s, {
        asUserId: s.bobId,
        question: 'Anyone up for lunch?',
        replyPlacement: 'channel',
        text: 'Lunch sounds good.',
      })
      assert.ok(!bobs.sent.includes(NOTE))
      assert.equal(await consumedBy(checkpointId), null, 'Bob\'s turn does not consume what it cannot read')

      const resumed = await aliceContinues(s)
      assert.ok(resumed.sent.includes(NOTE), 'Alice can still keep going')
      assert.equal(await consumedBy(checkpointId), resumed.runId)
      assert.equal(await readableBy(s, s.bobId, resumed.posted), false, 'and her answer stays restricted')
    })
  })

  await t.test('a member who may read a checkpoint may continue it, as the Continue press allows', async (st) => {
    await withFixture(st, async (s) => {
      const checkpointId = await seedStoppedRun(harness, s, { restricted: true })

      const owners = await ask(s, {
        asUserId: s.ownerId,
        question: 'Carry on with the vendors.',
        replyPlacement: 'channel',
        text: 'Carrying on with Acme and Globex.',
      })
      assert.ok(owners.sent.includes(NOTE))
      assert.equal(await consumedBy(checkpointId), owners.runId)
    })
  })

  // A schedule's run that stopped at a ceiling continues on its own. When its
  // continuation found the thread busy it used to leave the work to the run
  // holding it — which resumes nothing it was not handed — so now it waits.
  await t.test('an automation\'s continuation waits for a busy thread, then resumes', async (st) => {
    await withFixture(st, async (s) => {
      const { RunAutoContinuationJobPayloadSchema, RunExecuteJobPayloadSchema } = await import('@nessie/schemas')
      const { persistRunCheckpoint } = await import('../../src/run/execute/checkpoint.js')
      const { startAutoContinuation } = await import('../../src/run/execute/continuation.js')
      const stopped = await fire(s, 'Researching today\'s joke took longer than planned.')
      const stoppedJob = await prisma.queueJob.findFirstOrThrow({
        where: { topic: 'run.execute', payload: { path: ['runId'], equals: stopped.runId } },
      })
      const source = RunExecuteJobPayloadSchema.parse(stoppedJob.payload)
      const checkpointId = await persistRunCheckpoint(prisma, {
        agentId: s.agentId,
        basis: [],
        disclosureSources: [],
        generation: 1,
        note: NOTE,
        organizationId: s.organizationId,
        reason: 'token_limit',
        rootMessageId: null,
        runId: stopped.runId,
        sources: [],
        taskId: source.taskId,
        threadId: s.roomThreadId,
      })
      // Something else of this agent's is running in the room.
      const holder = await prisma.run.create({
        data: { agentId: s.agentId, status: 'running', threadId: s.roomThreadId },
      })

      const continuation = {
        attempt: 1,
        checkpointId,
        source,
        stoppedRun: {
          agentId: s.agentId,
          channelId: s.roomId,
          id: stopped.runId,
          organizationId: s.organizationId,
          principalUserId: null,
          replyPlacement: 'channel' as const,
          threadId: s.roomThreadId,
        },
      }
      assert.equal(await startAutoContinuation(prisma, continuation), null)
      assert.equal(await consumedBy(checkpointId), null)
      const waiting = await prisma.queueJob.findFirstOrThrow({
        where: { idempotencyKey: `run:continue:wait:${checkpointId}:2` },
      })
      assert.equal(waiting.topic, 'run.auto_continuation')

      await prisma.run.update({ where: { id: holder.id }, data: { finishedAt: new Date(), status: 'completed' } })
      const resumedRunId = await startAutoContinuation(prisma, RunAutoContinuationJobPayloadSchema.parse(waiting.payload))
      assert.ok(resumedRunId)
      assert.equal(await consumedBy(checkpointId), resumedRunId)
      assert.equal(
        (await prisma.run.findUniqueOrThrow({ where: { id: resumedRunId } })).continuationOfRunId,
        stopped.runId,
      )
      const resumed = await harness.execute(resumedRunId, 'Here is the joke, finally.')
      assert.ok(resumed.sent.includes(NOTE), 'the continuation resumes from the notes it was handed')
    })
  })

  await t.test('another agent in the room does not take it', async (st) => {
    await withFixture(st, async (s) => {
      const checkpointId = await seedStoppedRun(harness, s, { restricted: false })
      const other = await prisma.agent.create({
        data: { name: 'Standup', organizationId: s.organizationId, projectId: s.projectId, teamId: s.teamId },
      })
      await prisma.agentBinding.create({ data: { agentId: other.id, channelId: s.roomId } })

      const standup = await ask(s, {
        agentId: other.id,
        asUserId: s.aliceId,
        question: 'Post the standup reminder.',
        replyPlacement: 'channel',
        text: 'Standup in five minutes.',
      })
      assert.ok(!standup.sent.includes(NOTE), 'another agent is not handed this agent\'s notes')
      assert.equal(await consumedBy(checkpointId), null)
    })
  })
})

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer, request as httpRequest, type Server } from 'node:http'

import { Prisma, type PrismaClient } from '@prisma/client'
import type { MockScenario } from '@nessie/mock-llm'
import { RunExecuteJobPayloadSchema } from '@nessie/schemas'

// A public room with an agent and its owner's schedule, driven end to end
// through the real trigger fire and run executor with only inference pointed
// at the mock provider — every request that provider receives recorded, so a
// suite can assert what the model was sent. Shared by the room run suites in
// this directory; not a test file itself (`test:db` globs `*.test.ts`).
//
// Model config must be in place before any worker module loads, so this module
// sets it at load and imports worker code only inside `startRoomHarness`.

process.env['NESSIE_MODEL_PROVIDER'] ??= 'openai'
process.env['NESSIE_MODEL_API_KEY'] ??= 'mock-token'
process.env['OPENAI_API_KEY'] ??= 'mock-token'
process.env['NESSIE_DB_URL'] ??= process.env['DATABASE_URL'] ?? ''

// The engine picks its turn by the assistant turns already in the window, so
// every turn of the script is the one reply the next run should give.
const scenarioFor = (text: string, parse: (input: unknown) => MockScenario): MockScenario =>
  parse({ name: 'room-run', turns: Array.from({ length: 30 }, () => ({ latencyMs: 0, text })) })

const startRecordingProxy = async (
  target: string,
  requests: string[],
): Promise<{ server: Server; url: string }> => {
  const upstream = new URL(target)
  const server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = []
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
    incoming.on('end', () => {
      const body = Buffer.concat(chunks)
      if ((incoming.url ?? '').includes('/chat/completions')) requests.push(body.toString('utf8'))
      const forward = httpRequest({
        headers: incoming.headers,
        host: upstream.hostname,
        method: incoming.method,
        path: incoming.url,
        port: upstream.port,
      }, (proxied) => {
        outgoing.writeHead(proxied.statusCode ?? 500, proxied.headers)
        proxied.pipe(outgoing)
      })
      forward.end(body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  return { server, url: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}` }
}

export type Room = {
  agentId: string
  config: {
    createdByUserId: string
    launchOrigin: { organizationId: string; projectId: string; teamId: string; userId: string }
    prompt: string
  }
  organizationId: string
  /** The agent's owner, who also wrote the schedule. */
  ownerId: string
  /** Everyone in the room by display name, the owner included. */
  people: Record<string, string>
  projectId: string
  roomId: string
  roomThreadId: string
  teamId: string
  triggerId: string
}

type Cleanable = { after: (fn: () => Promise<void>) => void }

const seedRoom = async (
  prisma: PrismaClient,
  t: Cleanable,
  names: readonly [string, ...string[]],
): Promise<Room> => {
  const suffix = randomUUID()
  const users = await Promise.all(names.map((name) =>
    prisma.user.create({ data: { displayName: name, email: `room-run-${name}-${suffix}@example.test` } })))
  const organization = await prisma.organization.create({ data: { name: `room-run-${suffix}` } })
  t.after(async () => {
    // A completion follow-up and a waiting auto-continuation carry their run's
    // job under `source`.
    await prisma.$executeRaw(Prisma.sql`
      DELETE FROM queue_jobs
      WHERE payload->>'organizationId' = ${organization.id}
         OR payload->'actorContext'->'tenant'->>'organizationId' = ${organization.id}
         OR payload->'source'->'actorContext'->'tenant'->>'organizationId' = ${organization.id}`)
    await prisma.organization.deleteMany({ where: { id: organization.id } })
    await prisma.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } })
  })
  await prisma.organizationMember.createMany({
    data: users.map((user) => ({ organizationId: organization.id, role: 'member', userId: user.id })),
  })
  const project = await prisma.project.create({ data: { name: `Company ${suffix}`, organizationId: organization.id } })
  await prisma.projectMember.createMany({ data: users.map((user) => ({ projectId: project.id, userId: user.id })) })
  const team = await prisma.team.create({ data: { name: `Everyone ${suffix}`, projectId: project.id } })
  await prisma.teamMember.createMany({ data: users.map((user) => ({ teamId: team.id, userId: user.id })) })
  const room = await prisma.channel.create({
    data: {
      label: 'random',
      organizationId: organization.id,
      projectId: project.id,
      slug: `random-${suffix}`,
      teamId: team.id,
      type: 'standard',
      visibility: 'public',
    },
  })
  await prisma.channelMember.createMany({ data: users.map((user) => ({ channelId: room.id, userId: user.id })) })
  const roomThread = await prisma.thread.create({ data: { channelId: room.id } })
  const owner = users[0]!
  const agent = await prisma.agent.create({
    data: {
      name: 'Morning Joke',
      organizationId: organization.id,
      ownerUserId: owner.id,
      projectId: project.id,
      teamId: team.id,
    },
  })
  await prisma.agentBinding.create({ data: { agentId: agent.id, channelId: room.id } })
  const config = {
    createdByUserId: owner.id,
    launchOrigin: { organizationId: organization.id, projectId: project.id, teamId: team.id, userId: owner.id },
    prompt: 'Post one short, original joke to start the day.',
  }
  const trigger = await prisma.agentTrigger.create({
    data: { agentId: agent.id, config, targetChannelId: room.id, targetThreadId: roomThread.id, type: 'scheduled' },
  })
  return {
    agentId: agent.id,
    config,
    organizationId: organization.id,
    ownerId: owner.id,
    people: Object.fromEntries(users.map((user, index) => [names[index]!, user.id])),
    projectId: project.id,
    roomId: room.id,
    roomThreadId: roomThread.id,
    teamId: team.id,
    triggerId: trigger.id,
  }
}

export const startRoomHarness = async () => {
  const { createMockLlmServer, parseScenario } = await import('@nessie/mock-llm')
  let reply = 'Nothing to say.'
  const requests: string[] = []
  const mock = await createMockLlmServer({
    scenario: scenarioFor(reply, parseScenario),
    mainScenarioResolver: () => scenarioFor(reply, parseScenario),
  })
  const proxy = await startRecordingProxy(mock.url, requests)
  process.env['NESSIE_MODEL_BASE_URL'] = `${proxy.url}/v1`
  const { startMockPipeline } = await import('../../test-harness/pipeline.js')
  const pipeline = await startMockPipeline({ workers: 0 })
  const { executeRunJob } = await import('../../src/run/execute.js')
  const { queueTriggerRun } = await import('../../src/control/trigger-run.js')
  const { partitionByDisclosure, resolveDisclosureViewer } = await import('@nessie/runtime')
  const prisma = pipeline.prisma

  // Runs one queued run to completion with the given reply, and returns what
  // it posted and every request the model received while it ran.
  const execute = async (runId: string, text: string) => {
    reply = text
    requests.length = 0
    const job = await prisma.queueJob.findFirstOrThrow({
      where: { topic: 'run.execute', payload: { path: ['runId'], equals: runId } },
    })
    await executeRunJob(pipeline.deps, RunExecuteJobPayloadSchema.parse(job.payload), { attempt: 1, maxAttempts: 3 })
    const run = await prisma.run.findUniqueOrThrow({ where: { id: runId } })
    assert.equal(run.status, 'completed')
    const posted = await prisma.message.findFirstOrThrow({
      where: { agentId: run.agentId, content: text, role: 'assistant', threadId: run.threadId },
      include: { basisScopes: true, disclosureSources: true },
    })
    return { posted, runId, sent: requests.join('\n') }
  }

  return {
    embeddingModel: pipeline.deps.modelClient.embeddingModel,
    execute,
    pool: pipeline.pool,
    prisma,

    /** A fresh room for one test, removed with it. The first name owns the agent and the schedule. */
    seedRoom: (t: Cleanable, names: readonly [string, ...string[]]) => seedRoom(prisma, t, names),

    /** The fire the scheduler makes, admission and all. */
    fire: async (room: Room, text: string) => {
      await queueTriggerRun(prisma, {
        admissionPolicy: 'scheduled_fail_closed',
        dedupeKey: `${room.triggerId}:${randomUUID()}`,
        payload: { scheduledFor: new Date().toISOString() },
        source: 'scheduler',
        trigger: {
          agent: { agentKind: 'shared', organizationId: room.organizationId, projectId: room.projectId, teamId: room.teamId },
          agentId: room.agentId,
          config: room.config,
          id: room.triggerId,
          targetChannelId: room.roomId,
          targetThreadId: room.roomThreadId,
          type: 'scheduled',
        },
      })
      const run = await prisma.run.findFirstOrThrow({ where: { triggerId: room.triggerId }, orderBy: { createdAt: 'desc' } })
      return execute(run.id, text)
    },

    /**
     * A person's own live turn in the room, as the channel route starts one:
     * the agent answers in a reply thread under the question unless
     * `replyPlacement: 'channel'` says it answers in the room itself.
     */
    ask: async (room: Room, input: {
      agentId?: string
      asUserId: string
      question: string
      replyPlacement?: 'channel'
      text: string
    }) => {
      const agentId = input.agentId ?? room.agentId
      const asked = await prisma.message.create({
        data: { content: input.question, role: 'user', threadId: room.roomThreadId, userId: input.asUserId },
      })
      const run = await prisma.run.create({
        data: {
          agentId,
          ...(input.replyPlacement ? { replyPlacement: input.replyPlacement } : {}),
          threadId: room.roomThreadId,
          triggerMessageId: asked.id,
        },
      })
      const task = await prisma.task.create({
        data: { agentId, organizationId: room.organizationId, projectId: room.projectId, runId: run.id, title: 'ask' },
      })
      await prisma.queueJob.create({
        data: {
          payload: RunExecuteJobPayloadSchema.parse({
            actorContext: {
              actor: { actorId: input.asUserId, actorType: 'user', roles: ['member'] },
              actionContext: {
                agentId,
                channelId: room.roomId,
                correlationId: randomUUID(),
                effectiveUserId: input.asUserId,
                requestId: randomUUID(),
                taskId: task.id,
                teamId: room.teamId,
                threadId: room.roomThreadId,
              },
              tenant: {
                channelId: room.roomId,
                organizationId: room.organizationId,
                projectId: room.projectId,
                teamId: room.teamId,
              },
            },
            agentId,
            interactive: true,
            messageId: asked.id,
            runId: run.id,
            taskId: task.id,
            threadId: room.roomThreadId,
          }) as unknown as Prisma.InputJsonValue,
          topic: 'run.execute',
        },
      })
      return execute(run.id, input.text)
    },

    readableBy: async (
      room: Room,
      userId: string,
      message: { basisScopes: { scopeId: string; scopeType: string }[] },
    ) => partitionByDisclosure(
      [message],
      await resolveDisclosureViewer(prisma, room.organizationId, userId),
    ).visible.length === 1,

    close: async () => {
      await pipeline.stop()
      await new Promise<void>((resolve) => proxy.server.close(() => resolve()))
      await mock.close()
    },
  }
}

export type RoomHarness = Awaited<ReturnType<typeof startRoomHarness>>

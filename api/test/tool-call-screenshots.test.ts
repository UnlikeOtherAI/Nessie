import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { ToolCallEntrySchema } from '@nessie/schemas'
import Fastify from 'fastify'

import { RunThinkingLogSchema } from '../src/contracts/messaging.js'
import { registerRawBodyJsonParser } from '../src/lib/raw-body-json-parser.js'
import { registerExecutorDaemonRoutes } from '../src/routes/executor-daemon-routes.js'
import { registerThreadRoutes } from '../src/routes/threads.js'
import { registerUploadRoutes } from '../src/routes/uploads.js'
import { loadAgentActivity, loadRunToolCalls } from '../src/services/agent-read-model.js'
import {
  ATTACHMENT_SECRET,
  attachmentTestPrisma,
  kelpieScreenshot,
  seedAttachmentWorld,
  type AttachmentWorld,
} from '../../packages/executor-manage/test/command-attachment-fixture.js'

/**
 * Where a person sees a local program's screenshots
 * (docs/plans/2026-09-22-executor-local-apps/screenshots.md §4), against a real
 * database: the agent page's tool log (`ToolCallEntry.id` and `attachments`)
 * and the thought log's tool lines carry the refs of the images the call
 * returned, and only for a viewer the attachment routes then serve them to —
 * a ref the viewer could not open is not listed at all.
 */

const dbTest = process.env.DATABASE_URL ? test : test.skip

type Harness = {
  app: ReturnType<typeof Fastify>
  as: (userId: string) => void
  world: AttachmentWorld
}

const withApp = async (run: (harness: Harness) => Promise<void>): Promise<void> => {
  const prisma = attachmentTestPrisma()
  const world = await seedAttachmentWorld(prisma, { channelVisibility: 'private' })
  let viewerId = world.holderId
  const app = Fastify({ logger: false })
  registerRawBodyJsonParser(app)
  const deps = {
    authSecret: 'tool-call-screenshots-test-secret',
    buildChannelRealtimeScopes: () => [],
    encryptionKeyRing: ATTACHMENT_SECRET,
    fileService: world.fileService,
    isPersonalAssistantChannelType: () => false,
    messageMemoryCaptureConfig: null,
    prisma,
    realtimeHub: { publishWs: async () => undefined },
    requireActorContext: () => ({
      actor: { actorType: 'user', actorId: viewerId, roles: ['member'] },
      actionContext: { requestId: randomUUID() },
      tenant: { organizationId: world.organizationId },
    }),
  }
  registerExecutorDaemonRoutes(app, deps as never)
  registerUploadRoutes(app, deps as never)
  registerThreadRoutes(app, deps as never)
  await app.ready()
  try {
    await run({ app, as: (userId) => { viewerId = userId }, world })
  } finally {
    await app.close()
    try {
      await prisma.message.deleteMany({ where: { threadId: world.threadId } })
      await world.cleanup()
    } finally {
      await prisma.$disconnect()
    }
  }
}

/** A Kelpie screenshot call: its ToolCall, the tool line it started, and the kept image. */
const screenshotCall = async ({ app, world }: Harness) => {
  const commandId = await world.createCommand('started')
  const uploaded = await app.inject({
    method: 'POST',
    url: '/api/executor-daemon/commands/attachment',
    payload: world.upload(commandId, kelpieScreenshot()) as unknown as Record<string, unknown>,
  })
  assert.equal(uploaded.statusCode, 200, uploaded.body)
  const { toolCallId } = await world.prisma.executorCommand.findUniqueOrThrow({
    where: { id: commandId },
    select: { toolCallId: true },
  })
  const attachment = await world.prisma.attachment.findFirstOrThrow({ where: { executorCommandId: commandId } })
  await world.prisma.runThinkingChunk.create({
    data: { content: 'I will look at the page.', kind: 'reasoning', runId: world.runId },
  })
  // The worker names the call on its line when the call ends.
  await world.prisma.runThinkingChunk.create({
    data: { content: 'executor_mcp_call: server=kelpie', kind: 'tool', runId: world.runId, toolCallId },
  })
  return { attachmentId: attachment.id, toolCallId }
}

const viewer = (world: AttachmentWorld, userId: string) => ({
  organizationId: world.organizationId,
  uoaIdentity: undefined,
  userId,
})

const thinkingLogAs = async (harness: Harness, userId: string) => {
  harness.as(userId)
  return harness.app.inject({
    method: 'GET',
    url: `/api/threads/${harness.world.threadId}/runs/${harness.world.runId}/thinking`,
  })
}

const attachmentStatusAs = async (harness: Harness, userId: string, path: string): Promise<number> => {
  harness.as(userId)
  return (await harness.app.inject({ method: 'GET', url: path })).statusCode
}

dbTest('a screenshot call reads back with its id and the image it returned, on both agent-page reads', async () => {
  await withApp(async (harness) => {
    const { world } = harness
    const { attachmentId, toolCallId } = await screenshotCall(harness)
    const expected = [{
      attachmentId,
      byteLength: 13_715,
      filename: 'kelpie-screenshot-1.png',
      hasThumbnail: true,
      mimeType: 'image/png',
    }]

    const activity = await loadAgentActivity(world.prisma, world.agentId, { visibility: viewer(world, world.holderId) })
    const [entry] = activity?.recentToolCalls ?? []
    assert.ok(entry, 'the call is in the agent page\'s tool log')
    assert.equal(entry.id, toolCallId)
    assert.deepEqual(entry.attachments, expected)
    assert.deepEqual(ToolCallEntrySchema.parse(entry), entry, 'the entry is the wire contract')
    // The run is live, so the same call is the current run's too.
    assert.deepEqual(activity?.currentRun?.toolCalls.map((call) => call.attachments), [expected])

    const runCalls = await loadRunToolCalls(world.prisma, world.agentId, world.runId, {
      visibility: viewer(world, world.colleagueId),
    })
    assert.deepEqual(runCalls.map((call) => [call.id, call.attachments]), [[toolCallId, expected]])

    // The ref is the whole of it: its bytes come from the ordinary routes.
    assert.equal(await attachmentStatusAs(harness, world.colleagueId, `/api/attachments/${attachmentId}/thumbnail`), 200)
    assert.equal(await attachmentStatusAs(harness, world.colleagueId, `/api/attachments/${attachmentId}`), 200)

    // Without a person reading, nothing is listed.
    const unattended = await loadRunToolCalls(world.prisma, world.agentId, world.runId)
    assert.deepEqual(unattended.map((call) => call.attachments), [[]])
  })
})

dbTest('the thought log names a call\'s screenshots on its tool line and nowhere else', async () => {
  await withApp(async (harness) => {
    const { world } = harness
    const { attachmentId } = await screenshotCall(harness)

    const response = await thinkingLogAs(harness, world.colleagueId)
    assert.equal(response.statusCode, 200, response.body)
    const log = RunThinkingLogSchema.parse(response.json().data)
    assert.deepEqual(log.entries.map((entry) => [entry.kind, entry.attachments?.map((image) => image.attachmentId)]), [
      ['reasoning', undefined],
      ['tool', [attachmentId]],
    ])

    // Someone outside the room reads neither the log nor the image.
    assert.equal((await thinkingLogAs(harness, world.outsiderId)).statusCode, 404)
    assert.equal(await attachmentStatusAs(harness, world.outsiderId, `/api/attachments/${attachmentId}/thumbnail`), 404)
  })
})

dbTest('a viewer the image would be refused to reads the call without its ref', async () => {
  await withApp(async (harness) => {
    const { world } = harness
    const { attachmentId, toolCallId } = await screenshotCall(harness)
    // The run was started by a message only its launching person may read.
    // The run itself has consumed no private source, so the room still reads
    // the call and the thought log — but the attachment arm asks the trigger's
    // basis too, and the image is withheld from everyone else.
    const trigger = await world.prisma.message.create({
      data: { content: 'Look at my dashboard', role: 'user', threadId: world.threadId, userId: world.holderId },
    })
    await world.prisma.messageBasisScope.create({
      data: { messageId: trigger.id, organizationId: world.organizationId, scopeId: world.holderId, scopeType: 'user' },
    })
    await world.prisma.run.update({ where: { id: world.runId }, data: { triggerMessageId: trigger.id } })

    assert.equal(await attachmentStatusAs(harness, world.colleagueId, `/api/attachments/${attachmentId}`), 404)
    const colleagueCalls = await loadRunToolCalls(world.prisma, world.agentId, world.runId, {
      visibility: viewer(world, world.colleagueId),
    })
    assert.deepEqual(colleagueCalls.map((call) => [call.id, call.attachments]), [[toolCallId, []]])
    const colleagueLog = await thinkingLogAs(harness, world.colleagueId)
    assert.equal(colleagueLog.statusCode, 200, colleagueLog.body)
    assert.deepEqual(
      RunThinkingLogSchema.parse(colleagueLog.json().data).entries.map((entry) => entry.attachments),
      [undefined, undefined],
    )

    // Its launching person still sees it in both places.
    assert.equal(await attachmentStatusAs(harness, world.holderId, `/api/attachments/${attachmentId}`), 200)
    const holderCalls = await loadRunToolCalls(world.prisma, world.agentId, world.runId, {
      visibility: viewer(world, world.holderId),
    })
    assert.deepEqual(holderCalls.map((call) => call.attachments.map((image) => image.attachmentId)), [[attachmentId]])
    const holderLog = RunThinkingLogSchema.parse((await thinkingLogAs(harness, world.holderId)).json().data)
    assert.deepEqual(holderLog.entries.at(-1)?.attachments?.map((image) => image.attachmentId), [attachmentId])
  })
})

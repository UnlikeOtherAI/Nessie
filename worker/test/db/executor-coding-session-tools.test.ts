import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { AuthorizedActionContextSchema, type ExecutorCodingSessionsFacts } from '@nessie/schemas'

import { createCodingHarness, type CodingHarness } from '../../../executor/test/coding-session-harness.js'
import { CODING_SESSIONS_CONFIG_DIGEST_ENV } from '../../../executor/src/coding-session/config.js'
import { createCodingSessionsDaemon } from '../../../executor/src/coding-sessions-daemon.js'
import { createExecutorToolExecution } from '../../src/run/execute/executor-tool-execution.js'
import type { ExecutionDependencies, RunContext } from '../../src/run/execute/types.js'
import { buildExecutorToolset } from '../../src/run/executor-toolset.js'
import {
  deleteLocalAppsLane,
  LANE_SECRET,
  launchLocalApps,
  localAppsToolPolicy,
  seedLocalAppsExecutor,
  startStandInDaemon,
} from './executor-lane-fixture.js'
import { runDatabaseTest } from './support.js'

/**
 * The agent's first-class coding tools, end to end
 * (docs/plans/2026-09-22-executor-local-apps/coding-sessions.md §8): a run
 * bound to a private executor its pairing owner launched is offered them,
 * and every call is an `mcp.call` through the real lane — encrypted queued
 * commands, the stamped owner, a stand-in daemon running the daemon's own
 * operation — to a real coding-sessions bridge, whose hosts drive the
 * scripted coding agent. The wait is the worker's: short status reads, and
 * it gives way when the person writes or the run is stopped.
 */

const SESSION_ID = /Started coding session ([0-9a-f-]{36})\./

runDatabaseTest('start, wait, review and close drive a real bridge, and a wait gives way to the person', { timeout: 240_000 }, async () => {
  const prisma = new PrismaClient()
  const organizationId = randomUUID()
  const userId = randomUUID()
  const agentId = randomUUID()
  const executorId = randomUUID()
  const ids: { channelId?: string; projectId?: string; runId?: string; teamId?: string; threadId?: string } = {}
  let harness: CodingHarness | undefined
  let daemon: ReturnType<typeof startStandInDaemon> | undefined
  const actor = AuthorizedActionContextSchema.parse({
    actor: { actorType: 'user', actorId: userId }, tenant: { organizationId },
    actionContext: { requestId: randomUUID() },
  })
  try {
    harness = await createCodingHarness({ reviewedDigest: true })
    const facts: ExecutorCodingSessionsFacts = {
      agents: ['claude', 'codex'], allowedToolCount: 0,
      configDigest: harness.server.env![CODING_SESSIONS_CONFIG_DIGEST_ENV]!,
      environmentNames: [], permissionMode: { claude: 'default', codex: 'default' },
      rootNames: ['work'], serverName: 'coding-sessions',
    }
    const codingBridge = createCodingSessionsDaemon({
      executorId, facts, servers: [harness.server], sessions: harness.manager, log: () => undefined,
    })

    await prisma.organization.create({ data: { id: organizationId, name: 'Coding session tools test' } })
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.test`, displayName: 'Machine owner' } })
    await prisma.organizationMember.create({ data: { organizationId, userId, role: 'member' } })
    const toolPolicy = await localAppsToolPolicy(prisma, organizationId)
    await prisma.agent.create({ data: { id: agentId, name: 'CTO', organizationId, toolPolicy } })
    await seedLocalAppsExecutor(prisma, actor, {
      agentId, codingSessions: facts, executorId, mcpServers: ['coding-sessions', 'kelpie'], organizationId, userId,
    })
    const project = await prisma.project.create({ data: { name: 'p', organizationId } })
    ids.projectId = project.id
    const team = await prisma.team.create({ data: { name: 't', projectId: project.id } })
    ids.teamId = team.id
    const channel = await prisma.channel.create({ data: {
      label: 'c', slug: `c-${randomUUID()}`, organizationId, projectId: project.id, teamId: team.id,
    } })
    ids.channelId = channel.id
    const thread = await prisma.thread.create({ data: { channelId: channel.id } })
    ids.threadId = thread.id
    const trigger = await prisma.message.create({ data: {
      content: 'Have Claude Code fix the pricing page', role: 'user', threadId: thread.id, userId,
    } })
    const run = await prisma.run.create({ data: { agentId, status: 'running', threadId: thread.id, triggerMessageId: trigger.id } })
    ids.runId = run.id
    await launchLocalApps(prisma, actor, { agentId, executorId, runId: run.id, userId })
    daemon = startStandInDaemon(prisma, { codingBridge, executorId, sessions: harness.manager })

    const toolset = await buildExecutorToolset(prisma, {
      agentId, agentToolPolicy: toolPolicy, encryptionSecret: LANE_SECRET, hostOutput: null, organizationId, runId: run.id,
    })
    assert.ok(toolset.handledNames.has('coding_session_wait'), [...toolset.handledNames].join(', '))
    const genericCall = toolset.descriptors.find((descriptor) => descriptor.toolName === 'executor_mcp_call')
    assert.deepEqual((genericCall?.inputSchema as { properties: { server: { enum: string[] } } }).properties.server.enum, ['kelpie'])

    const progress: string[] = []
    const execute = createExecutorToolExecution(
      { prisma } as unknown as ExecutionDependencies,
      { run: { id: run.id } } as unknown as RunContext,
      toolset,
      { onProgress: async (_toolName, line) => { progress.push(line) } },
    )
    let call = 0
    const tool = (name: string, args: Record<string, unknown>) => execute(name, args, `provider-${(call += 1)}`, actor)

    // Start: task becomes the bridge's prompt, and the stamped owner reaches it.
    const started = await tool('coding_session_start', { root: 'work', task: '#sleep=1500 first task' })
    assert.equal(started.success, true, started.output)
    const sessionId = SESSION_ID.exec(started.output)?.[1]
    assert.ok(sessionId, started.output)
    const delivered = daemon.delivered.at(-1)
    assert.deepEqual(delivered?.owner, { actorUserId: userId, agentId })
    assert.deepEqual((delivered?.args as { arguments: unknown }).arguments, {
      agent: 'claude', prompt: '#sleep=1500 first task', root: 'work',
    })

    // Wait: reads until the turn ends, then hands back the digest and the full summary.
    const waited = await tool('coding_session_wait', { sessionId })
    assert.equal(waited.success, true, waited.output)
    assert.match(waited.output, /^The turn ended and the session is waiting for input/)
    assert.match(waited.output, /Output from the coding agent you supervise\./)
    assert.match(waited.output, /"finalSummary":"[^"]*first task/)
    assert.match(progress.at(-1) ?? '', /^Claude Code: waiting for input — turn 1/)
    const reads = daemon.delivered.filter((entry) => (entry.args as { tool?: unknown }).tool === 'session_status')
    assert.ok(reads.length >= 1)
    assert.ok(reads.every((entry) => (entry.owner as { agentId?: unknown } | undefined)?.agentId === agentId))
    // Every read's row but the call's own is ended by the wait itself.
    const open = await prisma.toolCall.findMany({ where: { endedAt: null, runId: run.id, toolName: 'coding_session_wait' } })
    assert.deepEqual(open.map((row) => row.id), [waited.toolCallRecordId])
    // And names the call's own row as its parent, so the tool-call views show the wait once.
    const steps = await prisma.toolCall.findMany({
      where: { id: { not: waited.toolCallRecordId }, runId: run.id, toolName: 'coding_session_wait' },
      select: { parentToolCallId: true },
    })
    assert.ok(steps.every((row) => row.parentToolCallId === waited.toolCallRecordId), JSON.stringify(steps))

    const review = await tool('coding_session_review', { sessionId })
    assert.equal(review.success, true, review.output)
    assert.match(review.output, /^What the session actually changed/)
    assert.match(review.output, /"branch":"main"/)

    // A long turn, and the person writes in this conversation: the wait ends at once.
    const sent = await tool('coding_session_send', { message: '#sleep=60000 a much longer task', sessionId })
    assert.equal(sent.success, true, sent.output)
    const message = await prisma.message.create({ data: {
      content: 'Actually, stop — use the other design.', role: 'user', threadId: thread.id, userId,
    } })
    const pending = await prisma.runThreadPendingMessage.create({ data: {
      actorContext: actor, agentId, channelId: channel.id, interactive: true, messageId: message.id, threadId: thread.id,
    } })
    const beforeWrite = Date.now()
    const gaveWay = await tool('coding_session_wait', { sessionId })
    assert.match(gaveWay.output, /^The person sent a message; end your turn now with one line of status; you will read it next\./)
    assert.ok(Date.now() - beforeWrite < 30_000, 'the wait did not sit out its ten minutes')
    await prisma.runThreadPendingMessage.delete({ where: { seq: pending.seq } })

    // The person stops the run: the wait ends too, and the session keeps working.
    await prisma.run.update({ where: { id: run.id }, data: { cancelRequestedAt: new Date() } })
    const stopped = await tool('coding_session_wait', { sessionId })
    assert.match(stopped.output, /^The person stopped this run\. The coding session keeps working/)
    assert.match(stopped.output, /"status":"(working|starting|waiting_for_input)"/)

    const closed = await tool('coding_session_close', { sessionId })
    assert.equal(closed.success, true, closed.output)
    assert.match(closed.output, /^(Closing the session|The session is closed)/)
    await daemon.stop()
  } finally {
    await daemon?.stop().catch(() => undefined)
    await harness?.cleanup().catch(() => undefined)
    try {
      await deleteLocalAppsLane(prisma, { executorId, organizationId, runIds: ids.runId ? [ids.runId] : [] })
      if (ids.threadId) {
        await prisma.runThreadPendingMessage.deleteMany({ where: { threadId: ids.threadId } })
        await prisma.message.deleteMany({ where: { threadId: ids.threadId } })
        await prisma.thread.deleteMany({ where: { id: ids.threadId } })
      }
      if (ids.channelId) await prisma.channel.deleteMany({ where: { id: ids.channelId } })
      if (ids.teamId) await prisma.team.deleteMany({ where: { id: ids.teamId } })
      if (ids.projectId) await prisma.project.deleteMany({ where: { id: ids.projectId } })
      await prisma.agent.deleteMany({ where: { id: agentId, organizationId } })
      await prisma.organizationMember.deleteMany({ where: { organizationId } })
      await prisma.user.deleteMany({ where: { id: userId } })
      await prisma.organization.deleteMany({ where: { id: organizationId } })
    } finally {
      await prisma.$disconnect()
    }
  }
})

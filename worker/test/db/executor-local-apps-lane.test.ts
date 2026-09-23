import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { AuthorizedActionContextSchema } from '@nessie/schemas'

import { createExecutorMcpSessionManager } from '../../../executor/src/mcp-session-manager.js'
import { createExecutorToolExecution } from '../../src/run/execute/executor-tool-execution.js'
import type { ExecutionDependencies, RunContext } from '../../src/run/execute/types.js'
import { buildExecutorToolset } from '../../src/run/executor-toolset.js'
import {
  deleteLocalAppsLane,
  LANE_SECRET,
  launchLocalApps,
  localAppsToolPolicy,
  SCRIPTED_MCP_SERVER,
  seedLocalAppsExecutor,
  startStandInDaemon,
} from './executor-lane-fixture.js'
import { runDatabaseTest } from './support.js'

/**
 * The local-apps lane end to end through the control plane: a reviewed
 * revision that names a program, a person's launch bound to a run, the
 * worker's real toolset creating encrypted queued commands, and a daemon
 * stand-in that polls them, runs the daemon's own `mcp.*` operation against a
 * real MCP server subprocess and posts the receipts.
 *
 * It proves what the unit and subprocess suites cannot: that the server enum
 * comes from the bound revision, that a paged catalog costs one command per
 * page with every page's ToolCall ended, and that the argument shaping is in
 * the payload the daemon actually receives.
 */

runDatabaseTest('a launched local-apps run lists a paged catalog once and shapes its calls to it', async () => {
  const prisma = new PrismaClient()
  const organizationId = randomUUID()
  const userId = randomUUID()
  const agentId = randomUUID()
  const executorId = randomUUID()
  const ids: { channelId?: string; projectId?: string; runId?: string; teamId?: string; threadId?: string } = {}
  // Forty padded tools against an 8 KiB budget make the daemon page the catalog.
  const sessions = createExecutorMcpSessionManager([{
    command: [process.execPath, SCRIPTED_MCP_SERVER],
    env: { NESSIE_TEST_MCP_MODE: 'many-tools' },
    name: 'kelpie',
  }], { maxResultBytes: 8_192 }, { log: () => undefined, startTimeoutMs: 15_000 })
  let daemon: ReturnType<typeof startStandInDaemon> | undefined
  const actor = AuthorizedActionContextSchema.parse({
    actor: { actorType: 'user', actorId: userId }, tenant: { organizationId },
    actionContext: { requestId: randomUUID() },
  })
  try {
    await prisma.organization.create({ data: { id: organizationId, name: 'Local apps lane test' } })
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.test`, displayName: 'Machine owner' } })
    await prisma.organizationMember.create({ data: { organizationId, userId, role: 'member' } })
    const toolPolicy = await localAppsToolPolicy(prisma, organizationId)
    await prisma.agent.create({ data: { id: agentId, name: 'CTO', organizationId, toolPolicy } })
    await seedLocalAppsExecutor(prisma, actor, { agentId, executorId, mcpServers: ['kelpie'], organizationId, userId })

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
      content: 'Open example.com on my machine', role: 'user', threadId: thread.id, userId,
    } })
    const run = await prisma.run.create({ data: {
      agentId, status: 'running', threadId: thread.id, triggerMessageId: trigger.id,
    } })
    ids.runId = run.id
    await launchLocalApps(prisma, actor, { agentId, executorId, runId: run.id, userId })
    daemon = startStandInDaemon(prisma, { executorId, sessions })
    const { delivered } = daemon

    const toolset = await buildExecutorToolset(prisma, {
      agentId, agentToolPolicy: toolPolicy, encryptionSecret: LANE_SECRET, hostOutput: null, organizationId,
      runId: run.id,
    })
    for (const tool of toolset.descriptors) {
      const server = (tool.inputSchema as { properties: { server: { enum: string[] } } }).properties.server
      assert.deepEqual(server.enum, ['kelpie'], 'the enum is the bound revision’s reviewed program list')
    }
    const execute = createExecutorToolExecution(
      { prisma } as unknown as ExecutionDependencies,
      { run: { id: run.id } } as unknown as RunContext,
      toolset,
    )

    const listing = await execute('executor_mcp_tools', { server: 'kelpie' }, 'provider-call-1', actor)
    assert.equal(listing.success, true)
    assert.match(listing.output.split('\n')[0]!, /^The program `kelpie` offers 40 tools\./)
    const pages = delivered.filter((entry) => entry.operationKey === 'mcp.tools')
    assert.ok(pages.length > 1, `the catalog should page, got ${pages.length}`)
    assert.deepEqual(pages[0]!.args, { server: 'kelpie' })
    const rows = await prisma.toolCall.findMany({
      where: { runId: run.id, toolName: 'executor_mcp_tools' },
      orderBy: { startedAt: 'asc' },
      select: { endedAt: true, id: true, success: true },
    })
    assert.equal(rows.length, pages.length, 'one command and one ToolCall per page')
    assert.equal(listing.toolCallRecordId, rows[0]!.id, 'the model’s call ends the first page')
    assert.ok(rows.slice(1).every((row) => row.endedAt !== null && row.success === true), 'the walk ends the rest')

    const schema = await execute('executor_mcp_tools', { server: 'kelpie', tool: 'tool_003' }, 'provider-call-2', actor)
    assert.match(schema.output, /Input schema: \{"type":"object","properties":\{"value":\{"type":"string"\}\}\}/)
    assert.equal(delivered.filter((entry) => entry.operationKey === 'mcp.tools').length, pages.length, 'answered from the run’s copy')

    const called = await execute('executor_mcp_call', {
      arguments: '{"value":"hello"}',
      server: 'kelpie',
      tool: 'tool_003',
    }, 'provider-call-3', actor)
    assert.equal(called.success, true)
    assert.deepEqual(delivered.at(-1), {
      args: { arguments: { value: 'hello' }, server: 'kelpie', tool: 'tool_003' },
      operationKey: 'mcp.call',
    })
    const [open, banner] = called.output.split('\n')
    assert.equal(open, 'BEGIN UNTRUSTED EXTERNAL DATA')
    assert.match(banner!, /^Output of the program `kelpie` on the person's machine\./)
    assert.match(called.output, /\{"echoed":\{"value":"hello"\}\}/)
    // A backstop that gave up on that call names the row its command was
    // recorded under, which the worker chose before the command existed.
    const backstop = toolset.timeoutErrorFor('executor_mcp_call', 'provider-call-3') as { toolCallRecordId?: string }
    assert.equal(backstop.toolCallRecordId, called.toolCallRecordId)
    assert.equal(
      (toolset.timeoutErrorFor('executor_mcp_tools', 'provider-call-1') as { toolCallRecordId?: string }).toolCallRecordId,
      rows[0]!.id,
      'a walk is named by its first page, the model’s call',
    )
    await daemon.stop()
  } finally {
    await daemon?.stop().catch(() => undefined)
    await sessions.stopAll()
    try {
      await deleteLocalAppsLane(prisma, { executorId, organizationId, runIds: ids.runId ? [ids.runId] : [] })
      if (ids.threadId) {
        await prisma.message.deleteMany({ where: { threadId: ids.threadId } })
        await prisma.thread.deleteMany({ where: { id: ids.threadId } })
      }
      if (ids.channelId) await prisma.channel.deleteMany({ where: { id: ids.channelId } })
      if (ids.teamId) await prisma.team.deleteMany({ where: { id: ids.teamId } })
      if (ids.projectId) await prisma.project.deleteMany({ where: { id: ids.projectId } })
      await prisma.agent.deleteMany({ where: { id: agentId, organizationId } })
      await prisma.organizationMember.deleteMany({ where: { organizationId, userId } })
      await prisma.user.deleteMany({ where: { id: userId } })
      await prisma.organization.deleteMany({ where: { id: organizationId } })
    } finally {
      await prisma.$disconnect()
    }
  }
})

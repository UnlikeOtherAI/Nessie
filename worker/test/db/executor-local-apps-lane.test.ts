import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { PrismaClient } from '@prisma/client'
import {
  bindExecutorCandidateBundleInTransaction,
  confirmExecutorAccessChange,
  ensureExecutorLogicalTools,
  pollExecutorCommand,
  prepareExecutorAccessChange,
  recordExecutorCommandReceipt,
  resolveExecutorAvailabilityCandidates,
} from '@nessie/executor-manage'
import {
  AuthorizedActionContextSchema,
  canonicalExecutorJson,
  ExecutorCapabilityDescriptorSchema,
} from '@nessie/schemas'

import { executeExecutorMcpCommand } from '../../../executor/src/mcp-dispatch.js'
import { createExecutorMcpSessionManager } from '../../../executor/src/mcp-session-manager.js'
import { createExecutorToolExecution } from '../../src/run/execute/executor-tool-execution.js'
import type { ExecutionDependencies, RunContext } from '../../src/run/execute/types.js'
import { buildExecutorToolset } from '../../src/run/executor-toolset.js'
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

const SCRIPT = fileURLToPath(new URL('../../../executor/test/fixtures/scripted-mcp-server.mjs', import.meta.url))
const SECRET = 'local-apps-lane-test-secret'

const digest = (value: unknown): string =>
  `sha256:${createHash('sha256').update(canonicalExecutorJson(value)).digest('hex')}`

runDatabaseTest('a launched local-apps run lists a paged catalog once and shapes its calls to it', async () => {
  const prisma = new PrismaClient()
  const organizationId = randomUUID()
  const userId = randomUUID()
  const agentId = randomUUID()
  const executorId = randomUUID()
  const ids: { channelId?: string; projectId?: string; runId?: string; teamId?: string; threadId?: string } = {}
  // Forty padded tools against an 8 KiB budget make the daemon page the catalog.
  const sessions = createExecutorMcpSessionManager([{
    command: [process.execPath, SCRIPT],
    env: { NESSIE_TEST_MCP_MODE: 'many-tools' },
    name: 'kelpie',
  }], { maxResultBytes: 8_192 }, { log: () => undefined, startTimeoutMs: 15_000 })
  const delivered: Array<{ args: Record<string, unknown>; operationKey: string }> = []
  let daemonRunning = true
  const actor = AuthorizedActionContextSchema.parse({
    actor: { actorType: 'user', actorId: userId }, tenant: { organizationId },
    actionContext: { requestId: randomUUID() },
  })
  try {
    await prisma.organization.create({ data: { id: organizationId, name: 'Local apps lane test' } })
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.test`, displayName: 'Machine owner' } })
    await prisma.organizationMember.create({ data: { organizationId, userId, role: 'member' } })
    const tools = await ensureExecutorLogicalTools(prisma, organizationId)
    const toolPolicy = { [tools.get('mcp.tools')!]: true, [tools.get('mcp.call')!]: true }
    await prisma.agent.create({ data: { id: agentId, name: 'CTO', organizationId, toolPolicy } })
    await prisma.executor.create({ data: {
      id: executorId, organizationId, pairingOwnerUserId: userId, label: 'Owner workstation',
      scopeKind: 'private', status: 'online', lastSeenAt: new Date(), profiles: ['workspace_sandbox'],
      privateAssignments: { create: { principalKind: 'user', userId, role: 'admin' } },
    } })
    const descriptor = ExecutorCapabilityDescriptorSchema.parse({
      protocolVersion: 1, revision: 1, profiles: ['workspace_sandbox'], operationKeys: ['mcp.tools', 'mcp.call'],
      mcpServers: ['kelpie'],
      platform: { architecture: 'x64', os: 'windows', osMajorVersion: 26100 },
      supervisor: 'service', sandboxBackend: 'none', localPolicyDigest: `sha256:${'2'.repeat(64)}`,
      limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 2 },
    })
    await prisma.executorCapabilityRevision.create({ data: {
      executorId, revision: 1, descriptor, signature: 'reviewed-test-descriptor',
      localPolicyDigest: descriptor.localPolicyDigest, reviewStatus: 'active', reviewedByUserId: userId,
    } })
    const prepared = await prepareExecutorAccessChange(prisma, actor, {
      executorId, change: { kind: 'agent_executor_access', agentId, state: 'allowed' },
    })
    await confirmExecutorAccessChange(prisma, actor, {
      accessChangeId: prepared.accessChangeId, confirmationToken: prepared.confirmationToken,
      freshVerificationSatisfied: true,
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
      content: 'Open example.com on my machine', role: 'user', threadId: thread.id, userId,
    } })
    const run = await prisma.run.create({ data: {
      agentId, status: 'running', threadId: thread.id, triggerMessageId: trigger.id,
    } })
    ids.runId = run.id

    // The person's launch: an opaque candidate bound to exactly this run.
    const availability = await resolveExecutorAvailabilityCandidates(prisma, actor, {
      agentId, executorId, operationKeys: ['mcp.tools', 'mcp.call'], runId: run.id,
    })
    const candidate = availability.candidates[0]
    assert.ok(candidate, JSON.stringify(availability.explanations))
    await prisma.$transaction((tx) => bindExecutorCandidateBundleInTransaction(tx, {
      actorUserId: userId, candidateHandle: candidate.handle, operationKeys: ['mcp.tools', 'mcp.call'], runId: run.id,
    }))

    // The daemon stand-in: the worker's queue claim, then poll, run, receipt.
    const daemon = (async () => {
      while (daemonRunning) {
        const leased = await prisma.executorCommand.findMany({
          where: { binding: { runId: run.id }, state: 'leased' },
          select: { queueJobId: true },
        })
        await prisma.queueJob.updateMany({
          where: { id: { in: leased.map((command) => command.queueJobId) }, status: 'pending' },
          data: { lockedUntil: new Date(Date.now() + 300_000), status: 'processing' },
        })
        const envelope = await pollExecutorCommand(prisma, SECRET, executorId)
        if (!envelope) {
          await new Promise((resolve) => setTimeout(resolve, 50))
          continue
        }
        const payload = envelope.payload as { args: Record<string, unknown> }
        delivered.push({ args: payload.args, operationKey: envelope.operationKey })
        const at = new Date().toISOString()
        await recordExecutorCommandReceipt(prisma, SECRET, executorId, { commandId: envelope.commandId, occurredAt: at, state: 'accepted' }, undefined)
        await recordExecutorCommandReceipt(prisma, SECRET, executorId, { commandId: envelope.commandId, occurredAt: at, state: 'started' }, undefined)
        const result = await executeExecutorMcpCommand(envelope.operationKey as 'mcp.tools' | 'mcp.call', payload.args, sessions)
        await recordExecutorCommandReceipt(prisma, SECRET, executorId, {
          commandId: envelope.commandId, occurredAt: new Date().toISOString(), resultDigest: digest(result),
          state: 'result_acknowledged',
        }, result)
      }
    })()

    const toolset = await buildExecutorToolset(prisma, {
      agentId, agentToolPolicy: toolPolicy, encryptionSecret: SECRET, organizationId, runId: run.id,
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

    daemonRunning = false
    await daemon
  } finally {
    daemonRunning = false
    await sessions.stopAll()
    try {
      if (ids.runId) {
        const commands = await prisma.executorCommand.findMany({
          where: { binding: { runId: ids.runId } }, select: { id: true, queueJobId: true },
        })
        await prisma.executorCommand.deleteMany({ where: { id: { in: commands.map((command) => command.id) } } })
        await prisma.queueJob.deleteMany({ where: { id: { in: commands.map((command) => command.queueJobId) } } })
        await prisma.executorBinding.deleteMany({ where: { runId: ids.runId } })
        await prisma.run.deleteMany({ where: { id: ids.runId } })
      }
      await prisma.executorAvailabilityCandidate.deleteMany({ where: { executorId } })
      if (ids.threadId) {
        await prisma.message.deleteMany({ where: { threadId: ids.threadId } })
        await prisma.thread.deleteMany({ where: { id: ids.threadId } })
      }
      if (ids.channelId) await prisma.channel.deleteMany({ where: { id: ids.channelId } })
      if (ids.teamId) await prisma.team.deleteMany({ where: { id: ids.teamId } })
      await prisma.executor.deleteMany({ where: { id: executorId, organizationId } })
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

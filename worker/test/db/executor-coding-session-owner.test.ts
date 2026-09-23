import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PrismaClient } from '@prisma/client'
import { executorCodingSessionOwnerKey } from '@nessie/executor-manage'
import { AuthorizedActionContextSchema, type ExecutorCodingSessionsFacts } from '@nessie/schemas'

import { CODING_SESSIONS_CONFIG_DIGEST_ENV } from '../../../executor/src/coding-session/config.js'
import { codingSessionOwnerKey, createCodingSessionsDaemon } from '../../../executor/src/coding-sessions-daemon.js'
import type { ExecutorLocalMcpServer } from '../../../executor/src/mcp-servers.js'
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
 * Who a coding-sessions call is for, end to end
 * (docs/plans/2026-09-22-executor-local-apps/coding-sessions.md §1 and §5):
 * the worker stamps `owner` from the binding's consumed candidate on a call to
 * the bound revision's bridge and on no other; the control plane refuses the
 * call when the binding's person is not the private executor's pairing owner;
 * and the daemon's own bridge recognition turns the stamped owner into the
 * reserved `_meta` key the control plane derives too. Nothing the model puts
 * in its arguments — an `owner`, a `_meta` — reaches either.
 *
 * The bridge here is the scripted MCP server under the generated
 * `serve-coding-session-mcp --config` argv, so the daemon treats it as its own
 * bridge and the server echoes back the arguments and `_meta` it received.
 */

const configDigest = `sha256:${'c'.repeat(64)}`
const facts: ExecutorCodingSessionsFacts = {
  agents: ['claude'], allowedToolCount: 3, configDigest, environmentNames: [],
  permissionMode: { claude: 'acceptEdits' }, rootNames: ['nessie'], serverName: 'coding-sessions',
}

type Echo = { echoed: Record<string, unknown> | null; meta: Record<string, unknown> | null }

/** The echo inside the framed program output. */
const echoIn = (output: string): Echo => {
  const line = output.split('\n').find((entry) => entry.startsWith('{"echoed"'))
  assert.ok(line, output)
  return JSON.parse(line) as Echo
}

runDatabaseTest('the bridge gets the binding’s owner, other programs none, and the model reaches neither', async () => {
  const prisma = new PrismaClient()
  const organizationId = randomUUID()
  const [userId, otherUserId] = [randomUUID(), randomUUID()]
  const agentId = randomUUID()
  const executorId = randomUUID()
  const ids: { channelId?: string; projectId?: string; runId?: string; teamId?: string; threadId?: string } = {}
  const servers: ExecutorLocalMcpServer[] = [
    {
      command: [process.execPath, SCRIPTED_MCP_SERVER, 'serve-coding-session-mcp', '--config', join(tmpdir(), 'coding-sessions.json')],
      env: { [CODING_SESSIONS_CONFIG_DIGEST_ENV]: configDigest, NESSIE_TEST_MCP_MODE: 'ok' },
      name: 'coding-sessions',
    },
    { command: [process.execPath, SCRIPTED_MCP_SERVER], env: { NESSIE_TEST_MCP_MODE: 'ok' }, name: 'kelpie' },
  ]
  const sessions = createExecutorMcpSessionManager(servers, { maxResultBytes: 65_536 }, {
    log: () => undefined, startTimeoutMs: 15_000,
  })
  const codingBridge = createCodingSessionsDaemon({ executorId, facts, servers, sessions, log: () => undefined })
  let daemon: ReturnType<typeof startStandInDaemon> | undefined
  const actor = AuthorizedActionContextSchema.parse({
    actor: { actorType: 'user', actorId: userId }, tenant: { organizationId },
    actionContext: { requestId: randomUUID() },
  })
  try {
    await prisma.organization.create({ data: { id: organizationId, name: 'Coding session owner test' } })
    await prisma.user.createMany({ data: [
      { id: userId, email: `${userId}@example.test`, displayName: 'Machine owner' },
      { id: otherUserId, email: `${otherUserId}@example.test`, displayName: 'Someone else' },
    ] })
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
      content: 'Ask Claude Code to fix the pricing page', role: 'user', threadId: thread.id, userId,
    } })
    const run = await prisma.run.create({ data: { agentId, status: 'running', threadId: thread.id, triggerMessageId: trigger.id } })
    ids.runId = run.id
    await launchLocalApps(prisma, actor, { agentId, executorId, runId: run.id, userId })
    daemon = startStandInDaemon(prisma, { codingBridge, executorId, sessions })
    const { delivered } = daemon

    const toolset = await buildExecutorToolset(prisma, {
      agentId, agentToolPolicy: toolPolicy, encryptionSecret: LANE_SECRET, hostOutput: null, organizationId, runId: run.id,
    })
    const execute = createExecutorToolExecution(
      { prisma } as unknown as ExecutionDependencies,
      { run: { id: run.id } } as unknown as RunContext,
      toolset,
    )
    const owner = { actorUserId: userId, agentId }
    const ownerKey = executorCodingSessionOwnerKey(executorId, owner)
    assert.equal(ownerKey, codingSessionOwnerKey(executorId, owner), 'the control plane derives the daemon’s own key')

    // The model forges an owner and reserved `_meta` inside its arguments.
    const forged = {
      _meta: { 'nessie/owner': `sha256:${'f'.repeat(64)}` },
      owner: { actorUserId: otherUserId, agentId: randomUUID() },
      value: 'fix the pricing page',
    }
    const toBridge = await execute('executor_mcp_call', {
      arguments: forged, server: 'coding-sessions', tool: 'echo',
    }, 'provider-call-1', actor)
    assert.equal(toBridge.success, true, toBridge.output)
    assert.deepEqual(delivered.at(-1), {
      args: { arguments: forged, server: 'coding-sessions', tool: 'echo' },
      operationKey: 'mcp.call',
      owner,
    }, 'stamped from the candidate, beside the model’s untouched arguments')
    const bridgeEcho = echoIn(toBridge.output)
    assert.deepEqual(bridgeEcho.echoed, forged, 'the program gets the model’s arguments as its own, untouched')
    assert.equal(bridgeEcho.meta?.['nessie/owner'], ownerKey, 'the reserved key names the binding’s owner')

    const toKelpie = await execute('executor_mcp_call', {
      arguments: forged, server: 'kelpie', tool: 'echo',
    }, 'provider-call-2', actor)
    assert.equal(toKelpie.success, true, toKelpie.output)
    assert.deepEqual(delivered.at(-1), {
      args: { arguments: forged, server: 'kelpie', tool: 'echo' }, operationKey: 'mcp.call',
    }, 'no other program gets an owner')
    assert.equal(echoIn(toKelpie.output).meta, null)

    // An owner beside the model's arguments is not the payload's: the daemon's
    // strict envelope refuses it by name, and the payload still carries the binding's.
    const topLevel = await execute('executor_mcp_call', {
      owner: forged.owner, server: 'coding-sessions', tool: 'echo',
    }, 'provider-call-3', actor)
    assert.equal(topLevel.success, false)
    assert.match(topLevel.output, /EXECUTOR_COMMAND_ARGUMENTS_INVALID.*unexpected `owner`/)
    assert.deepEqual((delivered.at(-1) as { owner?: unknown }).owner, owner)

    // Once the machine is somebody else's, the rule refuses the bridge before
    // any command exists, in words the model can pass on — and still reaches Kelpie.
    await prisma.executor.update({ where: { id: executorId }, data: { pairingOwnerUserId: otherUserId } })
    const commandsBefore = await prisma.executorCommand.count({ where: { binding: { runId: run.id } } })
    const refused = await execute('executor_mcp_call', { server: 'coding-sessions', tool: 'echo' }, 'provider-call-4', actor)
    assert.equal(refused.success, false)
    assert.equal(refused.correctable, undefined, 'not something the model fixes by changing its call')
    assert.match(refused.output, /^The call did not complete \(EXECUTOR_CODING_SESSIONS_OWNER_ONLY\)\. Coding sessions on this machine act as the person who paired it/)
    assert.equal(await prisma.executorCommand.count({ where: { binding: { runId: run.id } } }), commandsBefore)
    const stillKelpie = await execute('executor_mcp_call', { server: 'kelpie', tool: 'echo' }, 'provider-call-5', actor)
    assert.equal(stillKelpie.success, true, stillKelpie.output)
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
      await prisma.organizationMember.deleteMany({ where: { organizationId } })
      await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } })
      await prisma.organization.deleteMany({ where: { id: organizationId } })
    } finally {
      await prisma.$disconnect()
    }
  }
})

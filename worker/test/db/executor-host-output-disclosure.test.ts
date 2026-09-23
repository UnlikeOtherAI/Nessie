import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { AuthorizedActionContextSchema, parseOrganizationId, parseUserId } from '@nessie/schemas'

import { createExecutorMcpSessionManager } from '../../../executor/src/mcp-session-manager.js'
import { createConsumedSourceSink, type ConsumedSourceSink } from '../../src/run/execute/disclosure-basis.js'
import { createExecutorToolExecution } from '../../src/run/execute/executor-tool-execution.js'
import { loadConversation } from '../../src/run/execute/prompt.js'
import type { ExecutionDependencies, RunContext } from '../../src/run/execute/types.js'
import { launchConversationScope } from '../../src/run/executor-host-output.js'
import { buildExecutorToolset } from '../../src/run/executor-toolset.js'
import { runTicketBoardCreateTool } from '../../src/run/pa-tools/peer-delegation.js'
import { runTicketCreateTool } from '../../src/run/pa-tools/tickets.js'
import type { BuiltinToolRuntimeContext } from '../../src/run/tool-types.js'
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
 * Host program output is the launch conversation's (disclosure-boundaries.md).
 *
 * Each case reads a local program's output through the real lane — the
 * worker's toolset, an encrypted queued command, the daemon's own `mcp.call`
 * against a real MCP subprocess — into a real run sink, and then asks the one
 * project write gate, through the ticket tools an agent calls, whether that
 * output may land on a board:
 *
 * - launched in a public channel of the project: yes, every project reader
 *   can already read that room;
 * - launched in a protected channel of the same project: no;
 * - onto another project's board: no.
 *
 * The last case is the sales walkthrough's refusal
 * (docs/testing/sales-agent-collaboration.md): research read in a non-public
 * planning channel must not be copied into the wider project audience. The
 * channel scope such a run holds comes from the planning channel's own
 * transcript — a channel-scoped connector's reads stamp no scope of their own
 * — and it is still refused.
 */

type Channel = { id: string; projectId: string; teamId: string }

const REFUSED = /I cannot copy restricted research into this shared project/

runDatabaseTest('host program output reaches its launch project’s board only from a public channel', async () => {
  const prisma = new PrismaClient()
  const suffix = randomUUID().slice(0, 8)
  const organizationId = randomUUID()
  const ownerId = randomUUID()
  const collaboratorId = randomUUID()
  const agentId = randomUUID()
  const executorId = randomUUID()
  const runIds: string[] = []
  const sessions = createExecutorMcpSessionManager([{
    command: [process.execPath, SCRIPTED_MCP_SERVER],
    env: { NESSIE_TEST_MCP_MODE: 'ok' },
    name: 'kelpie',
  }], { maxResultBytes: 65_536 }, { log: () => undefined, startTimeoutMs: 15_000 })
  let daemon: ReturnType<typeof startStandInDaemon> | undefined
  const actor = AuthorizedActionContextSchema.parse({
    actor: { actorType: 'user', actorId: ownerId }, tenant: { organizationId },
    actionContext: { requestId: randomUUID() },
  })
  try {
    await prisma.organization.create({ data: { id: organizationId, name: `host-output-${suffix}` } })
    await prisma.user.createMany({ data: [
      { id: ownerId, email: `${ownerId}@example.test`, displayName: 'Machine owner' },
      { id: collaboratorId, email: `${collaboratorId}@example.test`, displayName: 'Collaborator' },
    ] })
    await prisma.organizationMember.createMany({ data: [
      { organizationId, role: 'owner', userId: ownerId },
      { organizationId, role: 'member', userId: collaboratorId },
    ] })
    const toolPolicy = await localAppsToolPolicy(prisma, organizationId)
    await prisma.agent.create({ data: { id: agentId, name: 'CTO', organizationId, toolPolicy } })
    await seedLocalAppsExecutor(prisma, actor, {
      agentId, executorId, mcpServers: ['kelpie'], organizationId, userId: ownerId,
    })

    const projectFor = async (name: string) => {
      const project = await prisma.project.create({ data: { name: `${name}-${suffix}`, organizationId } })
      const team = await prisma.team.create({ data: { name: `${name}-team-${suffix}`, projectId: project.id } })
      await prisma.projectMember.create({ data: { projectId: project.id, userId: collaboratorId } })
      return { projectId: project.id, teamId: team.id }
    }
    const channelIn = async (
      home: { projectId: string; teamId: string },
      label: string,
      visibility: 'protected' | 'public',
    ): Promise<Channel> => {
      const channel = await prisma.channel.create({ data: {
        label: `${label}-${suffix}`, organizationId, projectId: home.projectId, slug: `${label}-${suffix}`,
        teamId: home.teamId, type: 'standard', visibility,
      } })
      await prisma.channelMember.create({ data: { channelId: channel.id, userId: ownerId } })
      await prisma.agentBinding.create({ data: { agentId, channelId: channel.id } })
      return { id: channel.id, projectId: home.projectId, teamId: home.teamId }
    }
    const product = await projectFor('product')
    const elsewhere = await projectFor('elsewhere')
    const publicRoom = await channelIn(product, 'engineering', 'public')
    const protectedRoom = await channelIn(product, 'leadership', 'protected')
    const planningRoom = await channelIn(product, 'sales-planning', 'protected')
    daemon = startStandInDaemon(prisma, { executorId, sessions })

    const toolContext = (
      channel: Channel,
      sink: ConsumedSourceSink,
      agentKind: BuiltinToolRuntimeContext['agentKind'] = 'shared',
    ): BuiltinToolRuntimeContext => ({
      actorContext: {
        actionContext: { effectiveUserId: parseUserId(ownerId), requestId: randomUUID() },
        actor: { actorId: parseUserId(ownerId), actorType: 'user', roles: ['owner'] },
        tenant: { organizationId: parseOrganizationId(organizationId) },
      },
      agentId,
      agentKind,
      channel: {
        id: channel.id, organizationId: parseOrganizationId(organizationId), projectId: channel.projectId,
        systemChannelType: null, teamId: channel.teamId,
      },
      consumedSources: sink,
      ledgerIdentity: null,
      prisma,
      realtimeTransport: {} as BuiltinToolRuntimeContext['realtimeTransport'],
      run: { id: randomUUID(), messageId: randomUUID(), threadId: randomUUID() },
      toolCallId: randomUUID(),
    })

    /** A person launches local apps in `channel`; the agent reads one program answer. */
    const readHostOutput = async (channel: Channel): Promise<ConsumedSourceSink> => {
      const thread = await prisma.thread.create({ data: { channelId: channel.id } })
      const trigger = await prisma.message.create({ data: {
        content: 'Check the dashboard on my machine', role: 'user', threadId: thread.id, userId: ownerId,
      } })
      const run = await prisma.run.create({ data: {
        agentId, status: 'running', threadId: thread.id, triggerMessageId: trigger.id,
      } })
      runIds.push(run.id)
      await launchLocalApps(prisma, actor, { agentId, executorId, runId: run.id, userId: ownerId })
      const sink = createConsumedSourceSink()
      const toolset = await buildExecutorToolset(prisma, {
        agentId, agentToolPolicy: toolPolicy, encryptionSecret: LANE_SECRET,
        hostOutput: { launchScope: launchConversationScope(channel.id), sink },
        organizationId, runId: run.id,
      })
      const execute = createExecutorToolExecution(
        { prisma } as unknown as ExecutionDependencies,
        { run: { id: run.id } } as unknown as RunContext,
        toolset,
      )
      const answer = await execute('executor_mcp_call', {
        arguments: { value: 'HOST-OUTPUT-CANARY' }, server: 'kelpie', tool: 'echo',
      }, `provider-${run.id}`, actor)
      assert.equal(answer.success, true)
      assert.match(answer.output, /HOST-OUTPUT-CANARY/)
      assert.deepEqual(sink.list(), [{ scopeId: channel.id, scopeType: 'channel' }], 'the answer is the launch room’s')
      return sink
    }

    // A public project channel: its audience already contains the board's.
    const fromPublic = await readHostOutput(publicRoom)
    await runTicketCreateTool(toolContext(publicRoom, fromPublic), {
      projectId: product.projectId, title: 'Fix the dashboard HOST-OUTPUT-CANARY',
    })
    const created = await prisma.task.findMany({
      where: { organizationId, projectId: product.projectId, title: { contains: 'HOST-OUTPUT-CANARY' } },
      select: { id: true },
    })
    assert.equal(created.length, 1, 'the ticket landed on the launch project’s board')
    await runTicketBoardCreateTool(toolContext(publicRoom, fromPublic), { name: 'Dashboard follow-ups' })

    // A protected channel of the same project: read by its members alone.
    const fromProtected = await readHostOutput(protectedRoom)
    await assert.rejects(
      runTicketCreateTool(toolContext(protectedRoom, fromProtected), {
        projectId: product.projectId, title: 'From a protected room',
      }),
      REFUSED,
    )

    // Another project's board. An organisation owner's own assistant may reach
    // that project, so it is the disclosure gate, not the project guard, that
    // answers: the launch room belongs to a different project.
    const forElsewhere = await readHostOutput(publicRoom)
    await assert.rejects(
      runTicketCreateTool(toolContext(publicRoom, forElsewhere, 'personal_assistant'), {
        projectId: elsewhere.projectId, title: 'Somewhere else',
      }),
      REFUSED,
    )

    // The sales walkthrough: prospect research in a protected planning channel.
    const planningThread = await prisma.thread.create({ data: { channelId: planningRoom.id } })
    await prisma.message.create({ data: {
      content: 'Research Eska, Nordbeans and Můj šálek kávy and plan the backlog.',
      role: 'user', threadId: planningThread.id, userId: ownerId,
    } })
    const planning = createConsumedSourceSink()
    await loadConversation(prisma, {
      consumedSources: planning,
      organizationId,
      threadId: planningThread.id,
      viewer: { kind: 'user', scopes: [], userId: ownerId },
    })
    assert.deepEqual(planning.list(), [{ scopeId: planningRoom.id, scopeType: 'channel' }])
    await assert.rejects(
      runTicketBoardCreateTool(toolContext(planningRoom, planning), { name: 'KiloMayo prospect backlog' }),
      REFUSED,
    )
    // Host output from the public room does not open the planning channel's
    // research: each scope the run holds has to be implied on its own.
    planning.addAll(fromPublic.list())
    await assert.rejects(
      runTicketBoardCreateTool(toolContext(planningRoom, planning), { name: 'KiloMayo prospect backlog' }),
      REFUSED,
    )
    assert.equal(
      await prisma.board.count({ where: { name: 'KiloMayo prospect backlog', projectId: product.projectId } }),
      0,
    )
    await daemon.stop()
  } finally {
    await daemon?.stop().catch(() => undefined)
    await sessions.stopAll()
    try {
      await deleteLocalAppsLane(prisma, { executorId, organizationId, runIds })
      await prisma.organization.deleteMany({ where: { id: organizationId } })
      await prisma.user.deleteMany({ where: { id: { in: [ownerId, collaboratorId] } } })
    } finally {
      await prisma.$disconnect()
    }
  }
})

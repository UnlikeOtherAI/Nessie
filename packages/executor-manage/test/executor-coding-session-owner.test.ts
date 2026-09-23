import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import {
  assertExecutorCommandBindingCurrent,
  createExecutorCommand,
  pollExecutorCommand,
  readExecutorCommandResult,
} from '../src/index.js'
import {
  launchLocalApps,
  leaseTestPrisma,
  seedLeaseWorld,
  type LeaseWorld,
  type LeaseWorldOptions,
} from './lease-fixture.js'

/**
 * The private-executor rule for the coding-sessions bridge
 * (docs/plans/2026-09-22-executor-local-apps/coding-sessions.md §1 and §5),
 * against real rows: an `mcp.call` to the bridge is made only on a private
 * executor, for a binding made for the person who paired it, and its payload
 * carries exactly that binding's owner — the consumed candidate's agent and
 * person. Refused where the command is created, and again where the daemon
 * collects it.
 */

const dbTest = process.env.DATABASE_URL ? test : test.skip
const secret = 'coding-session-owner-test-secret'

const withWorld = async (options: LeaseWorldOptions, run: (world: LeaseWorld) => Promise<void>): Promise<void> => {
  const prisma = leaseTestPrisma()
  const world = await seedLeaseWorld(prisma, { codingSessions: true, ...options })
  try {
    await run(world)
  } finally {
    try { await world.cleanup() } finally { await prisma.$disconnect() }
  }
}

/** The holder's launch, and the binding its `mcp.call`s are made on. */
const launchedCall = async (world: LeaseWorld) => {
  const launch = await launchLocalApps(world)
  const binding = launch.bindings.find((entry) => entry.operationKey === 'mcp.call')
  assert.ok(binding)
  return { bindingId: binding.bindingId, runId: launch.run.id }
}

/** One command made the way the worker makes it: a ToolCall and a queue job, then the protocol record. */
const createCommand = async (
  world: LeaseWorld,
  input: { bindingId: string; payload: Record<string, unknown>; runId: string },
): Promise<string> => {
  const toolCall = await world.prisma.toolCall.create({ data: {
    agentId: world.agentId, executorBindingId: input.bindingId, inputSummary: 'executor_mcp_call',
    runId: input.runId, startedAt: new Date(), toolName: 'executor_mcp_call',
  } })
  const queueJob = await world.prisma.queueJob.create({ data: {
    idempotencyKey: `lease-test:${world.executorId}:${randomUUID()}`, payload: {}, status: 'processing',
    topic: 'executor.command',
  } })
  const commandId = randomUUID()
  await world.prisma.$transaction((tx) => createExecutorCommand(tx, {
    bindingId: input.bindingId, commandId, encryptionSecret: secret, expiresAt: new Date(Date.now() + 60_000),
    payload: input.payload, queueJobId: queueJob.id, toolCallId: toolCall.id,
  }))
  return commandId
}

const bridgeCall = { server: 'coding-sessions', tool: 'session_list' }

const refusedWith = (code: string, message?: RegExp) => (error: unknown) => {
  const refusal = error as { code?: string; message?: string }
  assert.equal(refusal.code, code)
  if (message) assert.match(refusal.message ?? '', message)
  return true
}

dbTest('the pairing owner of a private executor drives the bridge, stamped with the binding’s own owner', async () => {
  await withWorld({ pairingOwner: 'holder', scope: 'private' }, async (world) => {
    const { bindingId, runId } = await launchedCall(world)
    const current = await world.prisma.$transaction((tx) => assertExecutorCommandBindingCurrent(tx, bindingId))
    assert.deepEqual(current.owner, { actorUserId: world.holderId, agentId: world.agentId }, 'from the consumed candidate')

    const owner = { actorUserId: world.holderId, agentId: world.agentId }
    const commandId = await createCommand(world, { bindingId, payload: { args: bridgeCall, owner, runId }, runId })
    const envelope = await pollExecutorCommand(world.prisma, secret, world.executorId)
    assert.equal(envelope?.commandId, commandId)
    assert.deepEqual(envelope?.payload, { args: bridgeCall, owner, runId }, 'delivered with the owner, under the digest')
  })
})

dbTest('an owner that is not the binding’s, a missing one, or one on another server never becomes a command', async () => {
  await withWorld({ pairingOwner: 'holder', scope: 'private' }, async (world) => {
    const { bindingId, runId } = await launchedCall(world)
    const owner = { actorUserId: world.holderId, agentId: world.agentId }
    for (const payload of [
      { args: bridgeCall, runId },
      { args: bridgeCall, owner: { actorUserId: world.memberId, agentId: world.agentId }, runId },
      { args: bridgeCall, owner: { ...owner, extra: true }, runId },
      { args: { server: 'kelpie', tool: 'navigate' }, owner, runId },
    ]) {
      await assert.rejects(createCommand(world, { bindingId, payload, runId }), refusedWith('EXECUTOR_COMMAND_PAYLOAD_INVALID'))
    }
    assert.equal(await world.prisma.executorCommand.count({ where: { bindingId } }), 0)
    // Any other program is called without an owner, as it always was.
    await createCommand(world, { bindingId, payload: { args: { server: 'kelpie', tool: 'navigate' }, runId }, runId })
    assert.equal(await world.prisma.executorCommand.count({ where: { bindingId } }), 1)
  })
})

for (const [label, options, message] of [
  ['an organisation executor, even to the person who paired it', { pairingOwner: 'holder', scope: 'organization' }, /private executor/],
  ['a project executor, even to the person who paired it', { pairingOwner: 'holder', scope: 'project' }, /private executor/],
  ['a private executor, to anyone but the person who paired it', { pairingOwner: 'admin', scope: 'private' }, /someone else/],
] as const) {
  dbTest(`the bridge is refused on ${label}`, async () => {
    await withWorld(options, async (world) => {
      const { bindingId, runId } = await launchedCall(world)
      const payload = { args: bridgeCall, owner: { actorUserId: world.holderId, agentId: world.agentId }, runId }
      await assert.rejects(
        createCommand(world, { bindingId, payload, runId }),
        refusedWith('EXECUTOR_CODING_SESSIONS_OWNER_ONLY', message),
      )
      // Whatever it is called with: the reserved name is always the bridge's.
      await assert.rejects(
        createCommand(world, { bindingId, payload: { args: bridgeCall, runId }, runId }),
        refusedWith('EXECUTOR_CODING_SESSIONS_OWNER_ONLY'),
      )
      assert.equal(await world.prisma.executorCommand.count({ where: { bindingId } }), 0)
      // Every other program on the machine stays reachable.
      await createCommand(world, { bindingId, payload: { args: { server: 'kelpie', tool: 'navigate' }, runId }, runId })
    })
  })
}

dbTest('a command made while the rule held is refused as the daemon collects it once it no longer does', async () => {
  await withWorld({ pairingOwner: 'holder', scope: 'private' }, async (world) => {
    const { bindingId, runId } = await launchedCall(world)
    const owner = { actorUserId: world.holderId, agentId: world.agentId }
    const commandId = await createCommand(world, { bindingId, payload: { args: bridgeCall, owner, runId }, runId })
    await world.prisma.executor.update({ where: { id: world.executorId }, data: { pairingOwnerUserId: world.adminId } })

    assert.equal(await pollExecutorCommand(world.prisma, secret, world.executorId), null, 'nothing is delivered')
    const result = await readExecutorCommandResult(world.prisma, secret, commandId)
    assert.equal(result?.code, 'EXECUTOR_CODING_SESSIONS_OWNER_ONLY')
    assert.equal(result?.success, false)
    assert.match(String(result?.message), /only that person can drive them/)
  })
})

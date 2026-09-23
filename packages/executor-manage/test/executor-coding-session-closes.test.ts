import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto'
import test from 'node:test'
import { Prisma } from '@prisma/client'
import type { ExecutorLocalMcpReport } from '@nessie/schemas'

import {
  canonicalExecutorPayload,
  confirmExecutorAccessChange,
  endExecutorConversationLease,
  expireExecutorConversationLeases,
  prepareExecutorAccessChange,
  removePrivateAssignment,
  reportExecutorHeartbeat,
  transitionExecutorLifecycle,
  type ExecutorAccessChange,
} from '../src/index.js'
import {
  launchLocalApps,
  leaseTestPrisma,
  seedLeaseWorld,
  type LeaseWorld,
  type LeaseWorldOptions,
} from './lease-fixture.js'

/**
 * Close requests for coding sessions against real rows
 * (docs/executor-protocol/host-coding-sessions.md → "Teardown reaches the
 * machine"): written in the transaction of every lease end, access withdrawal
 * and machine fence, for the owner keys the daemon itself derives; carried on
 * every heartbeat, oldest first, until a report taken after the request shows
 * it done, or for a day.
 */

const dbTest = process.env.DATABASE_URL ? test : test.skip

const OWNED: LeaseWorldOptions = { codingSessions: true, pairingOwner: 'holder', scope: 'private' }

const withWorld = async (options: LeaseWorldOptions, run: (world: LeaseWorld) => Promise<void>): Promise<void> => {
  const prisma = leaseTestPrisma()
  const world = await seedLeaseWorld(prisma, options)
  try {
    await run(world)
  } finally {
    try { await world.cleanup() } finally { await prisma.$disconnect() }
  }
}

/** The daemon's derivation, spelled out: `sha256:` + hex SHA-256 of `executorId|agentId|actorUserId`. */
const ownerKeyOf = (executorId: string, agentId: string, actorUserId: string): string =>
  `sha256:${createHash('sha256').update(`${executorId}|${agentId}|${actorUserId}`).digest('hex')}`

const holderKey = (world: LeaseWorld): string => ownerKeyOf(world.executorId, world.agentId, world.holderId)

const closeRows = (world: LeaseWorld, where: Prisma.ExecutorCodingSessionCloseRequestWhereInput = {}) =>
  world.prisma.executorCodingSessionCloseRequest.findMany({
    where: { executorId: world.executorId, ...where },
    orderBy: { createdAt: 'asc' },
  })

const openRows = (world: LeaseWorld) => closeRows(world, { resolvedAt: null })

const confirm = async (world: LeaseWorld, change: ExecutorAccessChange) => {
  const prepared = await prepareExecutorAccessChange(world.prisma, world.adminContext, {
    executorId: world.executorId, change,
  })
  return confirmExecutorAccessChange(world.prisma, world.adminContext, {
    accessChangeId: prepared.accessChangeId, confirmationToken: prepared.confirmationToken,
    freshVerificationSatisfied: true,
  })
}

dbTest('a lease ended by its holder asks the machine to close their coding sessions', async () => {
  await withWorld(OWNED, async (world) => {
    const launch = await launchLocalApps(world)
    assert.equal((await closeRows(world)).length, 0, 'a launch asks for nothing')
    await endExecutorConversationLease(world.prisma, world.holderContext, { leaseId: launch.lease.id })
    const [row, ...rest] = await closeRows(world)
    assert.equal(rest.length, 0)
    assert.ok(row)
    assert.equal(row.ownerKey, holderKey(world), 'the key the daemon derives for that owner')
    assert.equal(row.reason, 'lease_ended')
    assert.equal(row.requestedByUserId, world.holderId)
    assert.equal(row.sessionId, null)
    assert.equal(row.resolvedAt, null)
  })
})

dbTest('the owner’s other live lease keeps the sessions; its last lease’s end, or expiry, closes them', async () => {
  await withWorld(OWNED, async (world) => {
    // Two launches in the same room, each its own conversation: one owner.
    const first = await launchLocalApps(world)
    const second = await launchLocalApps(world)
    await endExecutorConversationLease(world.prisma, world.holderContext, { leaseId: first.lease.id })
    assert.equal((await closeRows(world)).length, 0, 'another conversation may be driving them')
    // Only this world's lease is aged: the sweep is machine-wide, and other
    // suites' leases share the database.
    await world.prisma.executorConversationLease.update({
      where: { id: second.lease.id }, data: { idleExpiresAt: new Date(Date.now() - 1_000) },
    })
    await expireExecutorConversationLeases(world.prisma)
    const [row] = await closeRows(world)
    assert.equal(row?.reason, 'lease_ended')
    assert.equal(row?.requestedByUserId, null, 'nobody asked: the lease ran out')
    assert.equal((await world.prisma.executorConversationLease.findUniqueOrThrow({ where: { id: second.lease.id } })).endedReason, 'expired')
  })
})

dbTest('a relaunch in the same conversation withdraws the close its replaced lease asked for', async () => {
  await withWorld({ ...OWNED, agentConversation: true }, async (world) => {
    await launchLocalApps(world)
    await launchLocalApps(world)
    const rows = await closeRows(world)
    assert.equal(rows.length, 1, 'the replaced lease asked')
    assert.ok(rows[0]?.resolvedAt, 'and the new lease withdrew it in the same transaction')
    assert.equal((await openRows(world)).length, 0)
  })
})

dbTest('withdrawing the agent’s access, or the owner’s place on the roster, closes what it reached', async () => {
  await withWorld(OWNED, async (world) => {
    await launchLocalApps(world)
    await confirm(world, { kind: 'agent_executor_grant', agentId: world.agentId, state: 'denied' })
    const rows = await openRows(world)
    assert.deepEqual(rows.map((row) => [row.ownerKey, row.reason, row.requestedByUserId]), [
      [holderKey(world), 'access_revoked', world.adminId],
    ], 'once, though the lease end and the withdrawal both asked')
  })
  await withWorld(OWNED, async (world) => {
    // No lease at all: the grant alone reaches the owner's sessions.
    await confirm(world, { kind: 'agent_executor_grant', agentId: world.agentId, state: 'denied' })
    assert.deepEqual((await openRows(world)).map((row) => row.ownerKey), [holderKey(world)])
  })
  await withWorld(OWNED, async (world) => {
    await launchLocalApps(world)
    await removePrivateAssignment(world.prisma, world.adminContext, {
      executorId: world.executorId, principal: { principalKind: 'user', userId: world.holderId },
    })
    assert.deepEqual((await openRows(world)).map((row) => [row.ownerKey, row.reason]), [[holderKey(world), 'access_revoked']])
  })
})

type Listed = { ownerKey: string; sessionId?: string; status?: string }

const reportListing = (sessions: Listed[], observedAt: Date) => [{
  available: true,
  codingSessions: sessions.map((session) => ({
    agent: 'claude', ownerKey: session.ownerKey, root: 'nessie', sessionId: session.sessionId ?? randomUUID(),
    status: session.status ?? 'working', title: 'Fix the pricing page', updatedAt: observedAt.toISOString(),
  })),
  observedAt: observedAt.toISOString(),
  server: 'coding-sessions',
}] as ExecutorLocalMcpReport

dbTest('pausing or revoking the machine closes every owner who drove it and every owner its report listed', async () => {
  for (const [action, reason] of [['pause', 'executor_paused'], ['revoke', 'executor_revoked']] as const) {
    await withWorld(OWNED, async (world) => {
      await launchLocalApps(world)
      const stranger = `sha256:${'e'.repeat(64)}`
      await world.prisma.executor.update({
        where: { id: world.executorId },
        data: { localMcp: reportListing([{ ownerKey: stranger }], new Date()) as unknown as Prisma.InputJsonValue },
      })
      await transitionExecutorLifecycle(world.prisma, world.adminContext, { executorId: world.executorId, action })
      const rows = await openRows(world)
      assert.deepEqual(new Set(rows.map((row) => row.ownerKey)), new Set([holderKey(world), stranger]))
      assert.ok(rows.every((row) => row.reason === reason && row.requestedByUserId === world.adminId))
    })
  }
})

dbTest('no close is asked where nobody could have driven the bridge', async () => {
  for (const options of [
    { codingSessions: true, pairingOwner: 'holder', scope: 'organization' },
    { codingSessions: true, pairingOwner: 'admin', scope: 'private' },
  ] as const) {
    await withWorld(options, async (world) => {
      const launch = await launchLocalApps(world)
      await endExecutorConversationLease(world.prisma, world.holderContext, { leaseId: launch.lease.id })
      await confirm(world, { kind: 'agent_executor_grant', agentId: world.agentId, state: 'denied' })
      if (options.scope === 'organization') {
        await transitionExecutorLifecycle(world.prisma, world.adminContext, { executorId: world.executorId, action: 'pause' })
      }
      assert.deepEqual((await closeRows(world)).map((row) => row.ownerKey), options.scope === 'private'
        ? [ownerKeyOf(world.executorId, world.agentId, world.adminId)]
        : [], 'only the pairing owner of a private executor can own a session there')
    })
  }
})

dbTest('the table keeps its vocabulary and one open request per owner and per session', async () => {
  await withWorld(OWNED, async (world) => {
    const base = { executorId: world.executorId, ownerKey: holderKey(world), reason: 'person' }
    await world.prisma.executorCodingSessionCloseRequest.create({ data: base })
    const sessionId = randomUUID()
    await world.prisma.executorCodingSessionCloseRequest.create({ data: { ...base, sessionId } })
    for (const data of [base, { ...base, sessionId }]) {
      await assert.rejects(world.prisma.executorCodingSessionCloseRequest.create({ data }),
        (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
    }
    await world.prisma.executorCodingSessionCloseRequest.create({ data: { ...base, resolvedAt: new Date() } })
    for (const data of [{ ...base, reason: 'bored' }, { ...base, ownerKey: 'owner-a' }]) {
      await assert.rejects(world.prisma.executorCodingSessionCloseRequest.create({
        data: { ...data, resolvedAt: new Date() },
      }))
    }
  })
})

/* -------------------------------------------------------------------------- */
/* The heartbeat                                                               */
/* -------------------------------------------------------------------------- */

const pairMachine = async (world: LeaseWorld): Promise<KeyObject> => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url')
  await world.prisma.executor.update({ where: { id: world.executorId }, data: { machinePublicKey: raw } })
  return privateKey
}

const heartbeat = async (
  world: LeaseWorld,
  key: KeyObject,
  input: { localMcp?: ExecutorLocalMcpReport; now: Date },
) => {
  const executor = await world.prisma.executor.findUniqueOrThrow({
    where: { id: world.executorId }, select: { activeConnectionEpoch: true },
  })
  const payload = {
    connectionEpoch: executor.activeConnectionEpoch.toString(),
    executorId: world.executorId,
    ...(input.localMcp ? { localMcp: input.localMcp } : {}),
    observedAt: input.now.toISOString(),
  }
  const signature = sign(
    null, Buffer.from(canonicalExecutorPayload('nessie.executor.daemon.heartbeat.v1', payload)), key,
  ).toString('base64url')
  return reportExecutorHeartbeat(world.prisma, { ...payload, signature }, input.now)
}

const ask = async (world: LeaseWorld, input: { createdAt: Date; ownerKey: string; sessionId?: string }) => {
  await world.prisma.executorCodingSessionCloseRequest.create({ data: {
    createdAt: input.createdAt, executorId: world.executorId, ownerKey: input.ownerKey, reason: 'lease_ended',
    ...(input.sessionId ? { reason: 'person', sessionId: input.sessionId } : {}),
  } })
}

dbTest('the heartbeat carries open requests oldest first until a later report shows them done', async () => {
  await withWorld(OWNED, async (world) => {
    const key = await pairMachine(world)
    const asked = new Date(Date.now() - 5_000)
    const [ownerA, ownerB, ownerC] = ['a', 'b', 'd'].map((letter) => `sha256:${letter.repeat(64)}`) as [string, string, string]
    const [sessionA1, sessionA2] = [randomUUID(), randomUUID()]
    await ask(world, { createdAt: new Date(asked.getTime() + 2), ownerKey: ownerB })
    await ask(world, { createdAt: asked, ownerKey: ownerA, sessionId: sessionA1 })
    await ask(world, { createdAt: new Date(asked.getTime() + 4), ownerKey: ownerC })
    assert.equal((await heartbeat(world, key, { now: new Date() })).codingSessionClose?.length, 3)

    // Taken too soon after the requests to count: nothing settles, whatever it lists.
    const soon = await heartbeat(world, key, { localMcp: reportListing([], new Date()), now: new Date() })
    assert.deepEqual(soon.codingSessionClose, [
      { ownerKey: ownerA, reason: 'person', sessionId: sessionA1 },
      { ownerKey: ownerB, reason: 'lease_ended' },
      { ownerKey: ownerC, reason: 'lease_ended' },
    ], 'oldest first, the session named where one was')

    // Ninety seconds on: B is still open, A's named session is gone though A
    // has another, and C is not listed at all.
    const later = new Date(Date.now() + 90_000)
    const settled = await heartbeat(world, key, {
      localMcp: reportListing([{ ownerKey: ownerB }, { ownerKey: ownerA, sessionId: sessionA2 }], later),
      now: later,
    })
    assert.deepEqual(settled.codingSessionClose, [{ ownerKey: ownerB, reason: 'lease_ended' }])
    // Absent coding sessions say the bridge was not asked: that settles nothing.
    const unasked = [{ available: false, observedAt: later.toISOString(), reason: 'not_probed', server: 'coding-sessions' }]
    const notAsked = await heartbeat(world, key, { localMcp: unasked as ExecutorLocalMcpReport, now: later })
    assert.deepEqual(notAsked.codingSessionClose, [{ ownerKey: ownerB, reason: 'lease_ended' }])
    // B's session closed: nothing is left to say, and the key is left out.
    const closed = await heartbeat(world, key, { localMcp: reportListing([{ ownerKey: ownerB, status: 'closed' }], later), now: later })
    assert.equal(closed.codingSessionClose, undefined)
    assert.equal((await openRows(world)).length, 0)
    assert.equal((await closeRows(world)).every((row) => row.resolvedAt !== null), true)
  })
})

dbTest('a daemon that fronts no bridge settles every request; a day settles any; at most 64 travel', async () => {
  await withWorld(OWNED, async (world) => {
    const key = await pairMachine(world)
    const now = new Date()
    await world.prisma.executorCodingSessionCloseRequest.createMany({
      data: Array.from({ length: 70 }, (_, index) => ({
        createdAt: new Date(now.getTime() - 60_000 + index), executorId: world.executorId,
        ownerKey: `sha256:${index.toString(16).padStart(64, '0')}`, reason: 'lease_ended',
      })),
    })
    const first = await heartbeat(world, key, { now })
    assert.equal(first.codingSessionClose?.length, 64)
    assert.equal(first.codingSessionClose?.[0]?.ownerKey, `sha256:${'0'.repeat(64)}`, 'the oldest first')
    const kelpieOnly = [{ available: true, observedAt: now.toISOString(), server: 'kelpie' }] as ExecutorLocalMcpReport
    assert.equal((await heartbeat(world, key, { localMcp: kelpieOnly, now })).codingSessionClose, undefined)
    assert.equal((await openRows(world)).length, 0)

    await ask(world, { createdAt: new Date(now.getTime() - 25 * 60 * 60 * 1_000), ownerKey: holderKey(world) })
    assert.equal((await heartbeat(world, key, { now })).codingSessionClose, undefined, 'a day-old request is settled')
  })
})

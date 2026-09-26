import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import test from 'node:test'

import { EXISTING_CODING_SESSION_OWNER_KEY, canonicalExecutorPayload, type ExecutorSessionViewExchange } from '@nessie/schemas'

import {
  exchangeExecutorSessionViews, readExecutorSessionView, changeExecutorSessionShare, listExecutorHostSessions,
} from '../src/index.js'
import { leaseTestPrisma, seedLeaseWorld } from './lease-fixture.js'

const dbTest = process.env.DATABASE_URL ? test : test.skip
const secret = 'session-view-test-encryption'

dbTest('session screens are owner-only, encrypted, independently relayed, and epoch fenced', async () => {
  const prisma = leaseTestPrisma()
  const world = await seedLeaseWorld(prisma, { codingSessions: true, pairingOwner: 'holder', scope: 'private' })
  const now = new Date()
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const ownerKey = `sha256:${'a'.repeat(64)}`
  const ids = [randomUUID(), randomUUID()]
  try {
    await prisma.executor.update({ where: { id: world.executorId }, data: {
      machinePublicKey: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'),
      activeConnectionEpoch: 1,
      localMcp: [{ server: 'coding-sessions', available: true, observedAt: now.toISOString(), codingSessions: ids.map((sessionId) => ({
        sessionId, ownerKey, title: 'Terminal', agent: 'terminal', root: 'work', status: 'working', updatedAt: now.toISOString(),
      })) }],
    } })
    await prisma.executorHostSession.createMany({ data: ids.map((sessionId) => ({
      executorId: world.executorId, sessionId, ownerKey, title: 'Terminal', agent: 'terminal', root: 'work',
      status: 'working', reportedAt: now, requestedUntil: new Date(0),
    })) })
    const read = (sessionId: string, actor = world.holderContext, time = now) => readExecutorSessionView(
      prisma, secret, actor, { executorId: world.executorId, sessionId }, time,
    )
    await assert.rejects(read(ids[0]!, world.adminContext), /Session not found/)
    await assert.rejects(read(ids[0]!, world.memberContext), /Session not found/)
    await assert.rejects(read(randomUUID()), /Session not found/)
    assert.equal((await read(ids[0]!)).screen, null)
    assert.equal((await read(ids[1]!)).screen, null)
    const exchange = (
      frames: ExecutorSessionViewExchange['frames'], epoch = '1', time = now,
      sessions?: ExecutorSessionViewExchange['sessions'],
    ) => {
      const payload = {
        executorId: world.executorId, connectionEpoch: epoch, observedAt: time.toISOString(), frames,
        ...(sessions ? { sessions } : {}),
      }
      const signature = sign(null, Buffer.from(canonicalExecutorPayload('nessie.executor.daemon.session_view.v1', payload)), privateKey)
        .toString('base64url')
      return exchangeExecutorSessionViews(prisma, secret, { ...payload, signature }, time)
    }
    assert.equal((await exchange([])).requests.length, 2)
    const screen = (ansi: string) => ({ ansi, cols: 120, rows: 36, kind: 'terminal' as const, capturedAt: now.toISOString() })
    const frames = ids.map((sessionId, index) => ({ sessionId, ownerKey, screen: screen(`PRIVATE_TERMINAL_${index}`) }))
    await exchange(frames)
    assert.equal((await read(ids[0]!)).screen?.ansi, 'PRIVATE_TERMINAL_0')
    assert.equal((await read(ids[1]!)).screen?.ansi, 'PRIVATE_TERMINAL_1')
    const stored = await prisma.executorHostSession.findMany({ where: { executorId: world.executorId } })
    assert.ok(stored.every((row) => !row.screenCiphertext?.includes('PRIVATE_TERMINAL')))
    await assert.rejects(exchange(frames, '0'), /fenced/)
    const later = new Date(now.getTime() + 1_000)
    await exchange([{ ...frames[0]!, ownerKey: `sha256:${'b'.repeat(64)}`, screen: screen('WRONG_OWNER') }], '1', later)
    assert.equal((await read(ids[0]!)).screen?.ansi, 'PRIVATE_TERMINAL_0')
    await assert.rejects(read(ids[0]!, world.adminContext), /Session not found/)
    const expired = new Date(now.getTime() + 31_000)
    const member = await prisma.user.findUniqueOrThrow({ where: { id: world.memberContext.actor.actorId } })
    const input = { executorId: world.executorId, sessionId: ids[0]! }
    await assert.rejects(changeExecutorSessionShare(prisma, world.adminContext, input, { email: member.email }),
      /Session not found/)
    await changeExecutorSessionShare(prisma, world.holderContext, input, { email: member.email })
    await exchange([], '1', later, [{
      sessionId: ids[0]!, ownerKey: 'sha256:' + 'c'.repeat(64), title: 'Different owner',
      agent: 'terminal', root: 'work', status: 'working', updatedAt: later.toISOString(),
    }])
    assert.equal((await read(ids[0]!, world.memberContext)).session.title, 'Terminal',
      'a report cannot redirect an existing share to another owner')
    assert.equal((await read(ids[0]!, world.memberContext)).screen?.ansi, 'PRIVATE_TERMINAL_0')
    assert.equal((await read(ids[0]!, world.memberContext)).canShare, false)
    await assert.rejects(read(ids[1]!, world.memberContext), /Session not found/)
    assert.deepEqual((await listExecutorHostSessions(prisma, world.memberContext)).map((s) => s.sessionId), [ids[0]])
    await assert.rejects(changeExecutorSessionShare(prisma, world.memberContext, input, { email: member.email }),
      /Session not found/)
    await changeExecutorSessionShare(prisma, world.holderContext, input, { removeUserId: member.id })
    await assert.rejects(read(ids[0]!, world.memberContext), /Session not found/)
    assert.equal((await read(ids[0]!, world.holderContext, expired)).screen, null, 'an expired ciphertext is not served')
    await exchange([], '1', expired)
    assert.equal(await prisma.executorHostSession.count({ where: { executorId: world.executorId } }), 2,
      'session metadata survives expired viewer demand')
    assert.equal((await prisma.executorHostSession.findUniqueOrThrow({
      where: { executorId_sessionId: { executorId: world.executorId, sessionId: ids[1]! } },
    })).screenCiphertext, null)
    const discovered = randomUUID()
    await exchange([], '1', expired, [{
      sessionId: discovered, ownerKey, title: 'Discovered session',
      agent: 'terminal', root: 'work', status: 'closed', updatedAt: expired.toISOString(),
    }])
    assert.equal((await read(discovered)).session.title, 'Discovered session',
      'signed inventory creates durable session metadata even without an open viewer')
  } finally {
    await world.cleanup()
    await prisma.$disconnect()
  }
})


dbTest('external native sessions remain pairing-owner private even when an old share row exists', async () => {
  const prisma = leaseTestPrisma()
  const world = await seedLeaseWorld(prisma, { codingSessions: true, pairingOwner: 'holder', scope: 'private' })
  const sessionId = randomUUID()
  const input = { executorId: world.executorId, sessionId }
  try {
    await prisma.executorHostSession.create({ data: {
      ...input, ownerKey: EXISTING_CODING_SESSION_OWNER_KEY, title: 'Private native conversation', agent: 'codex',
      root: 'existing', status: 'unknown', reportedAt: new Date(), requestedUntil: new Date(0),
    } })
    const view = await readExecutorSessionView(prisma, secret, world.holderContext, input)
    assert.equal(view.canShare, false)
    assert.equal(view.session.origin, 'external')
    const memberId = world.memberContext.actor.actorId
    await prisma.executorHostSessionShare.create({ data: { ...input, userId: memberId } })
    await assert.rejects(readExecutorSessionView(prisma, secret, world.memberContext, input), /Session not found/u)
    await assert.rejects(readExecutorSessionView(prisma, secret, world.adminContext, input), /Session not found/u)
    assert.deepEqual(await listExecutorHostSessions(prisma, world.memberContext), [])
    await assert.rejects(changeExecutorSessionShare(prisma, world.holderContext, input, { removeUserId: memberId }),
      /Session not found/u)
  } finally { await world.cleanup(); await prisma.$disconnect() }
})

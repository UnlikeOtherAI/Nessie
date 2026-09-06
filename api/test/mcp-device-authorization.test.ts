import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import {
  decideDeviceAuthorization,
  loadPendingAuthorization,
  normalizeUserCode,
  redeemDeviceAuthorization,
  startDeviceAuthorization,
} from '../src/services/mcp-agent/device-authorization.js'
import { verifyAgentAccessCredential } from '../src/services/mcp-agent/agent-credential.js'

// Pairing is the only way an agent gets access, so the properties worth pinning
// are the ones that stop it granting more than a human chose: single use, no
// credential before approval, and an approval that cannot exceed what was asked.
const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

type Seed = { organizationId: string; projectId: string; userId: string }

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const org = await prisma.organization.create({ data: { name: `dev ${randomUUID()}` } })
  const project = await prisma.project.create({
    data: { name: 'p', organizationId: org.id },
  })
  const user = await prisma.user.create({
    data: { displayName: 'Approver', email: `dev-${randomUUID()}@example.test` },
  })
  await prisma.organizationMember.create({
    data: { organizationId: org.id, role: 'owner', userId: user.id },
  })
  return { organizationId: org.id, projectId: project.id, userId: user.id }
}

const cleanup = async (prisma: PrismaClient, s: Seed): Promise<void> => {
  await prisma.agentAccessCredential.deleteMany({ where: { userId: s.userId } })
  await prisma.agentAuthorizationRequest.deleteMany({ where: { approvedByUserId: s.userId } })
  await prisma.organization.delete({ where: { id: s.organizationId } })
  await prisma.user.delete({ where: { id: s.userId } }).catch(() => undefined)
}

test('a typed pairing code is read the way people type it', () => {
  // Lower case, missing dash, stray spaces — all the same code.
  assert.equal(normalizeUserCode('wxyz2345'), 'WXYZ-2345')
  assert.equal(normalizeUserCode(' wxyz-2345 '), 'WXYZ-2345')
  assert.equal(normalizeUserCode('WXYZ 2345'), 'WXYZ-2345')
})

runDatabaseTest('no approval, no credential', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const started = await startDeviceAuthorization(prisma, {
      clientName: 'Codex',
      scopes: ['boards_read'],
    })

    const pending = await redeemDeviceAuthorization(prisma, {
      deviceCode: started.deviceCode,
    })
    assert.equal(pending.kind, 'authorization_pending')

    const requests = await prisma.agentAccessCredential.count({ where: { userId: s.userId } })
    assert.equal(requests, 0, 'polling must not mint anything before a human decides')
  } finally {
    await prisma.agentAuthorizationRequest.deleteMany({ where: { clientName: 'Codex' } })
    await cleanup(prisma, s)
    await prisma.$disconnect()
  }
})

runDatabaseTest('approval mints exactly one credential, and the code cannot be replayed', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const started = await startDeviceAuthorization(prisma, {
      clientName: 'Claude Code',
      scopes: ['boards_read', 'documents_read'],
    })
    const pending = await loadPendingAuthorization(prisma, started.userCode)
    assert.notEqual(pending, null)

    await decideDeviceAuthorization(prisma, {
      approve: true,
      approvedScopes: ['boards_read', 'documents_read'],
      organizationId: s.organizationId,
      projectId: s.projectId,
      requestId: pending!.id,
      teamId: null,
      userId: s.userId,
    })

    const issued = await redeemDeviceAuthorization(prisma, { deviceCode: started.deviceCode })
    assert.equal(issued.kind, 'issued')
    if (issued.kind !== 'issued') return

    // The credential works, and acts as the approver.
    const verified = await verifyAgentAccessCredential(prisma, issued.credential.token)
    assert.equal(verified.ok, true)
    if (!verified.ok) return
    assert.equal(verified.actorContext.actor.actorId, s.userId)

    // Single use: a replayed device code mints nothing more.
    const replay = await redeemDeviceAuthorization(prisma, { deviceCode: started.deviceCode })
    assert.equal(replay.kind, 'invalid_grant')
    assert.equal(await prisma.agentAccessCredential.count({ where: { userId: s.userId } }), 1)
  } finally {
    await cleanup(prisma, s)
    await prisma.$disconnect()
  }
})

runDatabaseTest('an approval cannot grant a scope the agent never asked for', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const started = await startDeviceAuthorization(prisma, {
      clientName: 'Claude Code',
      scopes: ['boards_read'],
    })
    const pending = await loadPendingAuthorization(prisma, started.userCode)

    // A screen that offered more boxes than the request asked for — or a
    // crafted call to the decide endpoint — must not widen the grant.
    await decideDeviceAuthorization(prisma, {
      approve: true,
      approvedScopes: ['boards_read', 'boards_write', 'documents_write'],
      organizationId: s.organizationId,
      projectId: s.projectId,
      requestId: pending!.id,
      teamId: null,
      userId: s.userId,
    })

    const issued = await redeemDeviceAuthorization(prisma, { deviceCode: started.deviceCode })
    assert.equal(issued.kind, 'issued')
    if (issued.kind !== 'issued') return
    assert.deepEqual(
      issued.credential.credential.scopes,
      ['boards_read'],
      'the grant is the intersection of asked-for and approved, never the union',
    )
  } finally {
    await cleanup(prisma, s)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a refused pairing tells the agent to stop, not to retry', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const started = await startDeviceAuthorization(prisma, {
      clientName: 'Claude Code',
      scopes: ['boards_read'],
    })
    const pending = await loadPendingAuthorization(prisma, started.userCode)

    await decideDeviceAuthorization(prisma, {
      approve: false,
      approvedScopes: [],
      organizationId: s.organizationId,
      projectId: s.projectId,
      requestId: pending!.id,
      teamId: null,
      userId: s.userId,
    })

    const refused = await redeemDeviceAuthorization(prisma, { deviceCode: started.deviceCode })
    assert.equal(refused.kind, 'access_denied')
    assert.equal(await prisma.agentAccessCredential.count({ where: { userId: s.userId } }), 0)
  } finally {
    await prisma.agentAuthorizationRequest.deleteMany({ where: { clientName: 'Claude Code' } })
    await cleanup(prisma, s)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a decided pairing is no longer offered for approval', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const started = await startDeviceAuthorization(prisma, {
      clientName: 'Claude Code',
      scopes: ['boards_read'],
    })
    const pending = await loadPendingAuthorization(prisma, started.userCode)
    await decideDeviceAuthorization(prisma, {
      approve: true,
      approvedScopes: ['boards_read'],
      organizationId: s.organizationId,
      projectId: s.projectId,
      requestId: pending!.id,
      teamId: null,
      userId: s.userId,
    })

    // A second approver arriving at the same code sees nothing to decide.
    assert.equal(await loadPendingAuthorization(prisma, started.userCode), null)
  } finally {
    await cleanup(prisma, s)
    await prisma.$disconnect()
  }
})

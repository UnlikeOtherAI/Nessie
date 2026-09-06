import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import {
  AGENT_CREDENTIAL_PREFIX,
  isAgentCredentialToken,
  mintAgentAccessCredential,
  revokeAgentAccessCredential,
  verifyAgentAccessCredential,
} from '../src/services/mcp-agent/agent-credential.js'

// The agent credential is a foothold in somebody's account, so the properties
// that matter are the ones that take it away again: revocation, expiry, the
// user's own sign-out generation, and losing the membership it was scoped to.
// Each is re-read at verify time rather than trusted from the token, and these
// pin that.
const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

type Seed = { organizationId: string; projectId: string; userId: string }

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const org = await prisma.organization.create({ data: { name: `mcp ${randomUUID()}` } })
  const project = await prisma.project.create({
    data: { name: 'p', organizationId: org.id },
  })
  const user = await prisma.user.create({
    data: { displayName: 'Agent Owner', email: `mcp-${randomUUID()}@example.test` },
  })
  await prisma.organizationMember.create({
    data: { organizationId: org.id, role: 'owner', userId: user.id },
  })
  return { organizationId: org.id, projectId: project.id, userId: user.id }
}

const cleanup = async (prisma: PrismaClient, s: Seed): Promise<void> => {
  await prisma.organization.delete({ where: { id: s.organizationId } })
  await prisma.user.delete({ where: { id: s.userId } }).catch(() => undefined)
}

const mint = (prisma: PrismaClient, s: Seed) =>
  mintAgentAccessCredential(prisma, {
    label: 'Claude Code',
    organizationId: s.organizationId,
    projectId: s.projectId,
    scopes: ['boards_read', 'documents_read'],
    teamId: null,
    userId: s.userId,
  })

test('an agent token is recognisable by its prefix alone', () => {
  assert.equal(isAgentCredentialToken(`${AGENT_CREDENTIAL_PREFIX}abc`), true)
  // The voice credential's prefix must not be claimed by this verifier, or the
  // global hook would route a phone's credential to the wrong one.
  assert.equal(isAgentCredentialToken('nvc1_abc'), false)
  assert.equal(isAgentCredentialToken('eyJhbGciOi.jwt.token'), false)
})

runDatabaseTest('a freshly minted credential resolves to its granting human', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const { credential, token } = await mint(prisma, s)

    // The secret is never stored, only its digest.
    assert.notEqual(credential.tokenHash, token)
    assert.equal(credential.tokenHash.length, 64)

    const verified = await verifyAgentAccessCredential(prisma, token)
    assert.equal(verified.ok, true)
    if (!verified.ok) return
    assert.equal(verified.actorContext.actor.actorId, s.userId)
    assert.equal(verified.actorContext.actor.actorType, 'user')
    assert.equal(verified.actorContext.tenant.organizationId, s.organizationId)
    // Read from the live membership, so a demotion lands on the next call.
    assert.deepEqual(verified.actorContext.actor.roles, ['owner'])
    assert.deepEqual(verified.scopes, ['boards_read', 'documents_read'])
  } finally {
    await cleanup(prisma, s)
    await prisma.$disconnect()
  }
})

runDatabaseTest('revoking a credential stops it on the next call', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const { credential, token } = await mint(prisma, s)
    assert.equal((await verifyAgentAccessCredential(prisma, token)).ok, true)

    await revokeAgentAccessCredential(prisma, {
      credentialId: credential.id,
      organizationId: s.organizationId,
    })

    const after = await verifyAgentAccessCredential(prisma, token)
    assert.equal(after.ok, false)
    if (after.ok) return
    assert.equal(after.code, 'AGENT_CREDENTIAL_REVOKED')
  } finally {
    await cleanup(prisma, s)
    await prisma.$disconnect()
  }
})

runDatabaseTest('signing out everywhere also ends the agents you lent access to', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const { token } = await mint(prisma, s)
    assert.equal((await verifyAgentAccessCredential(prisma, token)).ok, true)

    // What a forced sign-out or password change does.
    await prisma.user.update({
      data: { tokenVersion: { increment: 1 } },
      where: { id: s.userId },
    })

    const after = await verifyAgentAccessCredential(prisma, token)
    assert.equal(
      after.ok,
      false,
      '"sign me out everywhere" must not mean "everywhere except my agents"',
    )
  } finally {
    await cleanup(prisma, s)
    await prisma.$disconnect()
  }
})

runDatabaseTest('losing the membership ends the credential scoped to it', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const { token } = await mint(prisma, s)
    await prisma.organizationMember.updateMany({
      data: { deactivatedAt: new Date() },
      where: { organizationId: s.organizationId, userId: s.userId },
    })

    const after = await verifyAgentAccessCredential(prisma, token)
    assert.equal(after.ok, false)
    if (after.ok) return
    assert.equal(after.code, 'AGENT_CREDENTIAL_REVOKED')
  } finally {
    await cleanup(prisma, s)
    await prisma.$disconnect()
  }
})

runDatabaseTest('an expired credential is refused as expired, not as invalid', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const { token } = await mintAgentAccessCredential(prisma, {
      label: 'Expiring',
      organizationId: s.organizationId,
      projectId: s.projectId,
      scopes: ['boards_read'],
      teamId: null,
      ttlMs: -1_000,
      userId: s.userId,
    })

    const after = await verifyAgentAccessCredential(prisma, token)
    assert.equal(after.ok, false)
    if (after.ok) return
    // The distinction is actionable: an agent should re-pair, not retry.
    assert.equal(after.code, 'AGENT_CREDENTIAL_EXPIRED')
  } finally {
    await cleanup(prisma, s)
    await prisma.$disconnect()
  }
})

runDatabaseTest('an unknown token resolves to nobody', async () => {
  const prisma = new PrismaClient()
  try {
    const after = await verifyAgentAccessCredential(
      prisma,
      `${AGENT_CREDENTIAL_PREFIX}not-a-real-credential`,
    )
    assert.equal(after.ok, false)
    if (after.ok) return
    assert.equal(after.code, 'AGENT_CREDENTIAL_INVALID')
  } finally {
    await prisma.$disconnect()
  }
})

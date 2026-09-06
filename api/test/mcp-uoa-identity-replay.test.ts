import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import {
  mintAgentAccessCredential,
  verifyAgentAccessCredential,
} from '../src/services/mcp-agent/agent-credential.js'

// A credential has no session, and the work an agent starts can outlive the
// call: creating a document enqueues an embedding job whose Ledger call needs
// the originating person's UOA workspace. Capturing it at approval and
// replaying it is the same answer scheduled triggers already use — without it
// the tool reports success and the indexing fails later, in the background,
// where nobody is looking.
const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

type Seed = { organizationId: string; projectId: string; userId: string }

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const org = await prisma.organization.create({ data: { name: `uoa ${randomUUID()}` } })
  const project = await prisma.project.create({ data: { name: 'p', organizationId: org.id } })
  const user = await prisma.user.create({
    data: { displayName: 'Approver', email: `uoa-${randomUUID()}@example.test` },
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

const IDENTITY = {
  organizationId: 'uoa-org-1',
  subject: 'uoa-sub-1',
  teamId: 'uoa-team-1',
  tokenVersion: 4,
}

runDatabaseTest('the approver\'s UOA workspace is replayed into the actor context', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const { token } = await mintAgentAccessCredential(prisma, {
      label: 'Claude Code',
      organizationId: s.organizationId,
      projectId: s.projectId,
      scopes: ['documents_write'],
      teamId: null,
      uoaIdentity: IDENTITY,
      userId: s.userId,
    })

    const verified = await verifyAgentAccessCredential(prisma, token)
    assert.equal(verified.ok, true)
    if (!verified.ok) return
    assert.deepEqual(verified.actorContext.actionContext.uoaIdentity, IDENTITY)
  } finally {
    await cleanup(prisma, s)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a credential minted without one simply carries none', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const { token } = await mintAgentAccessCredential(prisma, {
      label: 'Claude Code',
      organizationId: s.organizationId,
      projectId: s.projectId,
      scopes: ['boards_read'],
      teamId: null,
      userId: s.userId,
    })

    const verified = await verifyAgentAccessCredential(prisma, token)
    assert.equal(verified.ok, true)
    if (!verified.ok) return
    // Absent rather than null: the contract treats a missing identity as "not
    // carried", and a null is a different claim the schema rightly refuses.
    assert.equal(verified.actorContext.actionContext.uoaIdentity, undefined)
  } finally {
    await cleanup(prisma, s)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a stored identity that no longer parses is dropped, not signed with', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const { credential, token } = await mintAgentAccessCredential(prisma, {
      label: 'Claude Code',
      organizationId: s.organizationId,
      projectId: s.projectId,
      scopes: ['boards_read'],
      teamId: null,
      uoaIdentity: IDENTITY,
      userId: s.userId,
    })

    // What a contract change would leave behind.
    await prisma.agentAccessCredential.update({
      data: { uoaIdentity: { subject: 'only-a-subject' } },
      where: { id: credential.id },
    })

    const verified = await verifyAgentAccessCredential(prisma, token)
    // The credential still works for everything that does not need the
    // identity; the paths that do fail closed on their own.
    assert.equal(verified.ok, true)
    if (!verified.ok) return
    assert.equal(verified.actorContext.actionContext.uoaIdentity, undefined)
  } finally {
    await cleanup(prisma, s)
    await prisma.$disconnect()
  }
})

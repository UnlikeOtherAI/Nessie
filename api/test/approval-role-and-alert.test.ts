import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { AuthorizedActionContextSchema } from '@nessie/schemas'

import { createApprovalUserAlerts } from '@nessie/runtime'

import {
  createApprovalRequestOnce,
  resolveApprovalRequest,
} from '../src/services/approvals.js'

// Two questions this file answers, both about approvals nobody had exercised
// against a real database.
//
// Which role decides a role-gated approval: the actor context's, or a second
// read of `OrganizationMember`? They are the same value for a local-mode
// organisation and can differ for a UOA-bound one, where UOA owns the role and
// the local row is a projection refreshed at login and token rotation.
//
// And whether the person a request is pinned to is actually told about it.
const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

type Seed = {
  credentialId: string
  organizationId: string
  projectId: string
  userId: string
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const org = await prisma.organization.create({ data: { name: `role ${randomUUID()}` } })
  const project = await prisma.project.create({ data: { name: 'p', organizationId: org.id } })
  const user = await prisma.user.create({
    data: { displayName: 'Approver', email: `role-${randomUUID()}@example.test` },
  })
  const credential = await prisma.agentAccessCredential.create({
    data: {
      expiresAt: new Date(Date.now() + 86_400_000),
      label: 'Paired agent',
      organizationId: org.id,
      projectId: project.id,
      scopes: ['documents_read'],
      tokenHash: randomUUID(),
      tokenPrefix: 'nag1_role',
      tokenVersion: 0,
      userId: user.id,
    },
  })
  return {
    credentialId: credential.id,
    organizationId: org.id,
    projectId: project.id,
    userId: user.id,
  }
}

const cleanup = async (prisma: PrismaClient, s: Seed) => {
  await prisma.organization.delete({ where: { id: s.organizationId } })
  await prisma.user.delete({ where: { id: s.userId } }).catch(() => undefined)
  await prisma.$disconnect()
}

/** The context a request arrives with — `roles` is what the admission layer resolved. */
const contextFor = (s: Seed, roles: string[]) =>
  AuthorizedActionContextSchema.parse({
    actionContext: { requestId: randomUUID() },
    actor: { actorId: s.userId, actorType: 'user', roles },
    tenant: { organizationId: s.organizationId, projectId: s.projectId },
  })

/**
 * A role-gated approval pinned to our person.
 *
 * Both pins on one row on purpose: the named approver satisfies the visibility
 * and `APPROVER_REQUIRED` gates, which is what leaves the *role* gate as the
 * only thing left to decide. Without that, a member simply cannot see the row
 * and the test would pass for the wrong reason.
 */
const gatedApproval = async (prisma: PrismaClient, s: Seed) =>
  prisma.approvalRequest.create({
    data: {
      action: 'test.role_gate',
      agentAccessCredentialId: s.credentialId,
      continuationToken: randomUUID(),
      expiresAt: new Date(Date.now() + 3_600_000),
      organizationId: s.organizationId,
      projectId: s.projectId,
      reason: 'Role-gated',
      requesterId: s.credentialId,
      requiredApproverRole: 'owner',
      requiredApproverUserId: s.userId,
      status: 'pending',
    },
  })

const asOwner = async (prisma: PrismaClient, s: Seed) => {
  await prisma.organizationMember.create({
    data: { organizationId: s.organizationId, role: 'owner', userId: s.userId },
  })
}

runDatabaseTest('an owner in context, with a membership row, may resolve', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    await asOwner(prisma, s)
    const approval = await gatedApproval(prisma, s)

    const result = await resolveApprovalRequest(
      prisma,
      approval.id,
      contextFor(s, ['owner']),
      'approved',
    )
    assert.ok(result && !('error' in result && result.error), 'an owner must be able to resolve')
    assert.equal(result?.approval.status, 'approved')
  } finally {
    await cleanup(prisma, s)
  }
})

runDatabaseTest('a context demoted below the row still on disk is refused', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    // The UOA case, exactly: UOA has demoted this person and says so on every
    // request, while `OrganizationMember` still carries the old role until the
    // next login or token rotation re-projects it. Reading the row would let
    // them approve for the rest of that window; reading the context does not.
    await asOwner(prisma, s)
    const approval = await gatedApproval(prisma, s)

    const result = await resolveApprovalRequest(
      prisma,
      approval.id,
      contextFor(s, ['member']),
      'approved',
    )
    assert.ok(result && 'error' in result, 'a demoted approver must be refused')
    assert.equal(result?.error, 'ROLE_REQUIRED')

    const stored = await prisma.approvalRequest.findUniqueOrThrow({
      select: { status: true },
      where: { id: approval.id },
    })
    assert.equal(stored.status, 'pending', 'and nothing may have been decided')
  } finally {
    await cleanup(prisma, s)
  }
})

runDatabaseTest('an owner claim with no membership row is refused, not trusted', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    // No `asOwner` — no membership row at all. This is the one case where
    // `actor.roles` really can be a stale token claim: the admission layer only
    // overwrites it when a membership exists, and its outright refusal for a
    // missing membership fires only for a UOA-bound organisation. The
    // membership lookup here is what keeps that closed.
    const approval = await gatedApproval(prisma, s)

    const result = await resolveApprovalRequest(
      prisma,
      approval.id,
      contextFor(s, ['owner']),
      'approved',
    )
    assert.ok(result && 'error' in result, 'a claim without a membership must not decide')
    assert.equal(result?.error, 'ROLE_REQUIRED')
  } finally {
    await cleanup(prisma, s)
  }
})

runDatabaseTest('a pinned approval rings the person it is pinned to', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    await asOwner(prisma, s)
    const { approval } = await createApprovalRequestOnce(prisma, {
      action: 'knowledge.page.publish',
      actorContext: contextFor(s, ['owner']),
      context: { pageId: randomUUID(), versionId: randomUUID() },
      lockKey: `test:${randomUUID()}`,
      matches: () => false,
      reason: 'Please publish',
      requester: {
        agentAccessCredentialId: s.credentialId,
        requiredApproverUserId: s.userId,
      },
    })

    const alerts = await prisma.userAlert.findMany({
      where: { approvalRequestId: approval.id, organizationId: s.organizationId },
    })
    assert.equal(alerts.length, 1, 'exactly one bell for one decision')
    assert.equal(alerts[0]?.kind, 'approval_requested')
    assert.equal(alerts[0]?.userId, s.userId, 'and it goes to the pinned approver')
    assert.equal(alerts[0]?.readAt, null)
  } finally {
    await cleanup(prisma, s)
  }
})

runDatabaseTest('an agent that asks twice does not ring twice', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    await asOwner(prisma, s)
    const pageId = randomUUID()
    const versionId = randomUUID()
    const input = {
      action: 'knowledge.page.publish',
      actorContext: contextFor(s, ['owner']),
      context: { pageId, versionId },
      lockKey: `test:${pageId}:${versionId}`,
      matches: (rowContext: Record<string, unknown> | null) =>
        rowContext?.['pageId'] === pageId && rowContext?.['versionId'] === versionId,
      reason: 'Please publish',
      requester: {
        agentAccessCredentialId: s.credentialId,
        requiredApproverUserId: s.userId,
      },
    }

    const first = await createApprovalRequestOnce(prisma, input)
    const second = await createApprovalRequestOnce(prisma, input)
    assert.equal(second.created, false, 'the second ask reuses the open request')

    const alerts = await prisma.userAlert.findMany({
      where: { approvalRequestId: first.approval.id },
    })
    assert.equal(alerts.length, 1, 'a polling agent must not re-ring the bell')
  } finally {
    await cleanup(prisma, s)
  }
})

runDatabaseTest('a role-routed approval rings exactly the live holders of that role', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  const extras: string[] = []
  try {
    await asOwner(prisma, s)
    // A second owner must be told. A member must not — they cannot answer. A
    // deactivated owner must not either: an alert to somebody the resolve would
    // refuse is worse than no alert.
    for (const [role, deactivated] of [
      ['owner', false],
      ['member', false],
      ['owner', true],
    ] as const) {
      const person = await prisma.user.create({
        data: { displayName: role, email: `aud-${randomUUID()}@example.test` },
      })
      extras.push(person.id)
      await prisma.organizationMember.create({
        data: {
          deactivatedAt: deactivated ? new Date() : null,
          organizationId: s.organizationId,
          role,
          userId: person.id,
        },
      })
    }
    const [secondOwner] = extras

    // The audience rule itself, where it lives. Driving it through
    // `createApprovalRequestOnce` cannot reach this branch: its credential
    // requester always carries a named approver, and a pin is a stricter
    // audience than a role.
    const approval = await prisma.approvalRequest.create({
      data: {
        action: 'agent.todo_template.publish',
        agentAccessCredentialId: s.credentialId,
        continuationToken: randomUUID(),
        expiresAt: new Date(Date.now() + 3_600_000),
        organizationId: s.organizationId,
        reason: 'Agent-proposed template',
        requesterId: s.credentialId,
        requiredApproverRole: 'owner',
        status: 'pending',
      },
    })
    const rung = await createApprovalUserAlerts(prisma, {
      approvalId: approval.id,
      organizationId: s.organizationId,
      requiredApproverRole: 'owner',
    })

    assert.deepEqual(
      [...rung].sort(),
      [s.userId, secondOwner].sort(),
      'both live owners, and nobody else',
    )
  } finally {
    await prisma.userAlert.deleteMany({ where: { organizationId: s.organizationId } })
    await prisma.organizationMember.deleteMany({ where: { userId: { in: extras } } })
    await cleanup(prisma, s)
    // Only the rows this test made, never a blanket sweep of the database.
    const other = new PrismaClient()
    await other.user.deleteMany({ where: { id: { in: extras } } }).catch(() => undefined)
    await other.$disconnect()
  }
})

runDatabaseTest('an approval with neither pin nor role rings nobody', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    await asOwner(prisma, s)
    // Its audience is "anyone who can read the channel", which is what the
    // in-channel card is for. Ringing every reader would be noise, not news.
    const rung = await createApprovalUserAlerts(prisma, {
      approvalId: randomUUID(),
      organizationId: s.organizationId,
    })
    assert.deepEqual(rung, [])
  } finally {
    await cleanup(prisma, s)
  }
})

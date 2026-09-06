import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import {
  parseOrganizationId,
  type AuthorizedActionContext,
} from '@nessie/schemas'
import Fastify, { type FastifyInstance } from 'fastify'

import { registerApprovalRoutes } from '../src/routes/approvals.js'
import type { RouteDeps } from '../src/routes/types.js'

const dbTest = process.env.DATABASE_URL ? test : test.skip

type Seed = {
  agentId: string
  organizationId: string
  requesterId: string
  namedApproverId: string
  otherMemberId: string
}

const actorFor = (userId: string, seed: Seed): AuthorizedActionContext => ({
  actionContext: { requestId: `approval-resolve-route-${randomUUID()}` },
  actor: { actorId: userId, actorType: 'user', roles: ['owner'] },
  tenant: { organizationId: parseOrganizationId(seed.organizationId) },
})

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const organization = await prisma.organization.create({
    data: { name: `approval-route-${randomUUID()}` },
  })
  const agent = await prisma.agent.create({
    data: { name: 'Approvals agent', organizationId: organization.id },
  })
  const requester = await prisma.user.create({
    data: { displayName: 'Requester', email: `requester-${randomUUID()}@example.com` },
  })
  const namedApprover = await prisma.user.create({
    data: { displayName: 'Named approver', email: `named-${randomUUID()}@example.com` },
  })
  const otherMember = await prisma.user.create({
    data: { displayName: 'Other member', email: `other-${randomUUID()}@example.com` },
  })
  return {
    agentId: agent.id,
    organizationId: organization.id,
    requesterId: requester.id,
    namedApproverId: namedApprover.id,
    otherMemberId: otherMember.id,
  }
}

const cleanup = async (prisma: PrismaClient, s: Seed): Promise<void> => {
  await prisma.approvalRequest.deleteMany({ where: { organizationId: s.organizationId } })
  await prisma.agent.deleteMany({ where: { organizationId: s.organizationId } })
  await prisma.organization.deleteMany({ where: { id: s.organizationId } })
  await prisma.user.deleteMany({
    where: { id: { in: [s.requesterId, s.namedApproverId, s.otherMemberId] } },
  })
}

const createApp = (prisma: PrismaClient, actorContext: AuthorizedActionContext): FastifyInstance => {
  const app = Fastify({ logger: false })
  registerApprovalRoutes(app, {
    prisma,
    realtimeHub: { publishWs: async () => undefined },
    requireActorContext: () => actorContext,
  } as unknown as RouteDeps)
  return app
}

const createApproval = async (
  prisma: PrismaClient,
  s: Seed,
  overrides: { requiredApproverUserId?: string } = {},
) =>
  prisma.approvalRequest.create({
    data: {
      organizationId: s.organizationId,
      agentId: s.agentId,
      requesterId: s.requesterId,
      requiredApproverUserId: overrides.requiredApproverUserId,
      action: 'knowledge.publish',
      reason: 'Publish the onboarding page',
      continuationToken: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    },
  })

/**
 * `POST /api/approvals/:approvalId/resolve` now (a) validates its body with
 * `parseInput(ResolveApprovalBodySchema, ...)` instead of a raw
 * `request.body as {...}` cast (S1-F1-6 / S3-F1), (b) parses its response
 * through `ApprovalRequestRecordSchema` so `continuationToken` cannot leak
 * (S3-F1), and (c) maps every code `resolveApprovalRequest` can return —
 * including `APPROVER_REQUIRED` — to a real status via a `Record` keyed by
 * the service's own error union, so a status is a compile error to omit
 * (FO1-11), instead of a hand-copied list with an `?? 'Unknown error' 400`
 * fallback for anything missed.
 *
 * `APPROVER_REQUIRED` itself is not reachable through this HTTP surface
 * today: `approvalVisibilityWhere` (`services/approvals.ts`) already hides a
 * pinned approval from everyone but its named approver at the query level
 * (proven by `approval-visibility.test.ts`), so `resolveApprovalRequest`'s
 * own `requiredApproverUserId !== actorId` check can never see a row where
 * that is true. The map entry is still required for
 * `Record<ApprovalResolveErrorCode, ...>` to compile, and is what makes a
 * *future* relaxation of that visibility rule safe by default instead of a
 * silent 400.
 */

dbTest('resolve rejects a malformed body instead of reaching the service', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const approval = await createApproval(prisma, s)
    const app = createApp(prisma, actorFor(s.requesterId, s))
    try {
      const response = await app.inject({
        method: 'POST',
        payload: { resolution: 'maybe' },
        url: `/api/approvals/${approval.id}/resolve`,
      })
      assert.equal(response.statusCode, 400)
      assert.equal((response.json() as { error: { code: string } }).error.code, 'VALIDATION_ERROR')
    } finally {
      await app.close()
    }
  } finally {
    await cleanup(prisma, s)
    await prisma.$disconnect()
  }
})

dbTest('resolve refuses the requester approving their own request (SELF_APPROVAL, not the generic 400)', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const approval = await createApproval(prisma, s)
    const app = createApp(prisma, actorFor(s.requesterId, s))
    try {
      const response = await app.inject({
        method: 'POST',
        payload: { resolution: 'approved' },
        url: `/api/approvals/${approval.id}/resolve`,
      })
      assert.equal(response.statusCode, 403)
      assert.equal(
        (response.json() as { error: { code: string } }).error.code,
        'SELF_APPROVAL',
      )
    } finally {
      await app.close()
    }
  } finally {
    await cleanup(prisma, s)
    await prisma.$disconnect()
  }
})

dbTest('resolve by an eligible approver returns the parsed record without the continuation token', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const approval = await createApproval(prisma, s)
    const app = createApp(prisma, actorFor(s.otherMemberId, s))
    try {
      const response = await app.inject({
        method: 'POST',
        payload: { resolution: 'approved', note: 'Looks right' },
        url: `/api/approvals/${approval.id}/resolve`,
      })
      assert.equal(response.statusCode, 200, response.body)
      const body = response.json() as { data: Record<string, unknown> }
      assert.equal(body.data.id, approval.id)
      assert.equal(body.data.status, 'approved')
      assert.equal(body.data.organizationId, s.organizationId)
      assert.equal('continuationToken' in body.data, false)
    } finally {
      await app.close()
    }
  } finally {
    await cleanup(prisma, s)
    await prisma.$disconnect()
  }
})

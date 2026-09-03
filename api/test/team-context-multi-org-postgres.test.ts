import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import {
  resolveUoaLocalSessionContext,
  UoaLocalSessionBindingError,
} from '../src/services/uoa-session-context.js'
import { resolveUoaTeamContext } from '../src/services/team-context.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

// UOA organisations map 1:1 to local Organizations
// (`Organization.externalOrgId`). One person entitled to two UOA organisations
// gets two distinct local tenants — distinct budget/policy scopes — and a
// session proof for one org can never reach a team living in the other.

runDatabaseTest('one principal, two UOA organisations, two isolated local tenants', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const extOrgA = `uoa-org-a-${suffix}`
  const extOrgB = `uoa-org-b-${suffix}`
  const teamA = `uoa-team-a-${suffix}`
  const teamB = `uoa-team-b-${suffix}`
  const email = `multi-org-${suffix}@example.com`
  const uoaSub = `uoa-sub-multi-${suffix}`
  t.after(async () => {
    await prisma.user.deleteMany({ where: { email } })
    await prisma.organization.deleteMany({
      where: { externalOrgId: { in: [extOrgA, extOrgB] } },
    })
    await prisma.$disconnect()
  })
  const login = (input: {
    extOrgId: string
    extTeamId: string
    orgRole?: string
  }) => resolveUoaTeamContext(prisma, {
    displayName: 'Multi Org',
    email,
    uoaSub,
    team: {
      activeOrgId: input.extOrgId,
      activeTeamId: input.extTeamId,
      teamIds: [input.extTeamId],
      teamRoles: {},
      ...(input.orgRole ? { orgRole: input.orgRole } : {}),
    },
  })

  // Login to org A creates org A; the verified owner claim owns it.
  const a = await login({ extOrgId: extOrgA, extTeamId: teamA, orgRole: 'owner' })
  assert.ok(a)
  assert.equal(a.orgRole, 'owner')
  // Login to org B creates org B — a DISTINCT Organization.
  const b = await login({ extOrgId: extOrgB, extTeamId: teamB, orgRole: 'member' })
  assert.ok(b)
  assert.notEqual(b.organizationId, a.organizationId)
  assert.equal(a.userId, b.userId)
  // A verified member claim wins over first-materializer even on first entry.
  assert.equal(b.orgRole, 'member')
  const [orgRowA, orgRowB] = await Promise.all([
    prisma.organization.findUnique({
      where: { externalOrgId: extOrgA },
      select: { id: true },
    }),
    prisma.organization.findUnique({
      where: { externalOrgId: extOrgB },
      select: { id: true },
    }),
  ])
  assert.equal(orgRowA?.id, a.organizationId)
  assert.equal(orgRowB?.id, b.organizationId)
  // Each org carries its own policy scope — the team teams live in their
  // own org's project tree, so budgets/policies scope per UOA organisation.
  for (const context of [a, b]) {
    assert.ok(await prisma.policyRule.count({
      where: { organizationId: context.organizationId },
    }) > 0)
    const project = await prisma.project.findUnique({
      where: { id: context.projectId },
      select: { organizationId: true },
    })
    assert.equal(project?.organizationId, context.organizationId)
  }

  // Floor removal: the sole owner of org A demoted by UOA IS demoted — the
  // per-UOA-org claim is a complete statement (no shared-org last-owner floor).
  const demoted = await login({ extOrgId: extOrgA, extTeamId: teamA, orgRole: 'member' })
  assert.ok(demoted)
  assert.equal(demoted.orgRole, 'member')
  const memberRow = await prisma.organizationMember.findUnique({
    where: {
      organizationId_userId: {
        organizationId: a.organizationId,
        userId: a.userId,
      },
    },
    select: { role: true },
  })
  assert.equal(memberRow?.role, 'member')

  // Session binding: a proof for org A resolves org A's team…
  const tokenVersion = 5
  await prisma.productAccountLink.create({
    data: {
      organizationId: a.organizationId,
      userId: a.userId,
      productSlug: 'nessie',
      status: 'linked',
      uoaSub,
      uoaTokenVersion: tokenVersion,
      lastVerifiedAt: new Date(),
    },
  })
  const bound = await resolveUoaLocalSessionContext(prisma, {
    identity: {
      organizationId: extOrgA,
      subject: uoaSub,
      teamId: teamA,
      tokenVersion,
    },
    userId: a.userId,
  })
  assert.equal(bound.organizationId, a.organizationId)
  assert.equal(bound.teamId, a.teamId)
  // …and a proof claiming org A can NEVER reach org B's team, even though the
  // user is an active member of both organisations.
  await assert.rejects(
    resolveUoaLocalSessionContext(prisma, {
      identity: {
        organizationId: extOrgA,
        subject: uoaSub,
        teamId: teamB,
        tokenVersion,
      },
      userId: a.userId,
    }),
    UoaLocalSessionBindingError,
  )
})

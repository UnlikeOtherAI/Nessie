import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { resolveUoaWorkspaceContext } from '../src/services/workspace-context.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

// `resolveUoaWorkspaceContext` resolves "the shared organization" with a GLOBAL
// lookup (the oldest `Organization` row), so — exactly as
// `workspace-context-postgres-race.test.ts` explains — this suite anchors its
// own organization behind anything a concurrently running suite can create, and
// asserts that the lookup really resolved it. The anchor is distinct from that
// suite's two, because `findFirst` breaks a `created_at` tie arbitrarily.
const PROFILE_SYNC_ANCHOR = new Date('1970-01-01T00:00:00.002Z')

const FOREIGN_ORGANIZATION_RESOLVED =
  'the shared-organization lookup resolved an organization this suite does not own; '
  + 'point DATABASE_URL at a freshly migrated database'

runDatabaseTest('a UOA login re-syncs the profile mirror from its verified claims', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const externalOrgId = `uoa-org-profile-${suffix}`
  const externalTeamId = `uoa-team-profile-${suffix}`
  const email = `profile-sync-${suffix}@example.com`
  const uoaSub = `uoa-sub-profile-${suffix}`
  const organization = await prisma.organization.create({
    data: { name: `Profile sync ${suffix}`, createdAt: PROFILE_SYNC_ANCHOR },
  })
  let workspaceProjectId: string | null = null
  t.after(async () => {
    await prisma.user.deleteMany({ where: { email } })
    if (workspaceProjectId) {
      await prisma.project.delete({ where: { id: workspaceProjectId } }).catch(() => undefined)
    }
    await prisma.organization.delete({ where: { id: organization.id } }).catch(() => undefined)
    await prisma.$disconnect()
  })
  const workspace = {
    activeOrgId: externalOrgId,
    activeTeamId: externalTeamId,
    teamIds: [externalTeamId],
    teamRoles: { [externalTeamId]: 'member' },
  }

  // First login: UOA asserted no name at all, so the row is named by its
  // address rather than by a manufactured "Profile Sync".
  const first = await resolveUoaWorkspaceContext(prisma, { email, uoaSub, workspace })
  assert.ok(first)
  workspaceProjectId = first.projectId
  assert.equal(first.organizationId, organization.id, FOREIGN_ORGANIZATION_RESOLVED)
  const provisioned = await prisma.user.findUniqueOrThrow({
    where: { id: first.userId },
    select: { avatarUrl: true, displayName: true, updatedAt: true },
  })
  assert.equal(provisioned.displayName, email)
  assert.equal(provisioned.avatarUrl, null)

  // Second login, now with a name and a picture: the mirror follows.
  const renamed = await resolveUoaWorkspaceContext(prisma, {
    avatarUrl: 'https://uoa.test/ada.png',
    displayName: 'Ada Lovelace',
    email,
    uoaSub,
    workspace,
  })
  assert.ok(renamed)
  assert.equal(renamed.userId, first.userId)
  const synced = await prisma.user.findUniqueOrThrow({
    where: { id: first.userId },
    select: { avatarUrl: true, displayName: true, updatedAt: true },
  })
  assert.equal(synced.displayName, 'Ada Lovelace')
  assert.equal(synced.avatarUrl, 'https://uoa.test/ada.png')

  // Third login with the same claims writes nothing: `updatedAt` is
  // `@updatedAt`, so an unnecessary write would move it.
  const unchanged = await resolveUoaWorkspaceContext(prisma, {
    avatarUrl: 'https://uoa.test/ada.png',
    displayName: 'Ada Lovelace',
    email,
    uoaSub,
    workspace,
  })
  assert.ok(unchanged)
  const quiet = await prisma.user.findUniqueOrThrow({
    where: { id: first.userId },
    select: { displayName: true, updatedAt: true },
  })
  assert.equal(quiet.displayName, 'Ada Lovelace')
  assert.equal(quiet.updatedAt.getTime(), synced.updatedAt.getTime())

  // A login that asserts no name never blanks the mirror back to the address.
  await resolveUoaWorkspaceContext(prisma, { email, uoaSub, workspace })
  const preserved = await prisma.user.findUniqueOrThrow({
    where: { id: first.userId },
    select: { avatarUrl: true, displayName: true },
  })
  assert.equal(preserved.displayName, 'Ada Lovelace')
  assert.equal(preserved.avatarUrl, 'https://uoa.test/ada.png')
})

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { resolveUoaTeamContext } from '../src/services/team-context.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

// A UOA login resolves its Organization 1:1 by `Organization.externalOrgId`
// (per-UOA-org model), so with a per-suite unique external org id the
// resolution is deterministic — no epoch-dated anchor organization needed.

runDatabaseTest('a UOA login re-syncs the profile mirror from its verified claims', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const externalOrgId = `uoa-org-profile-${suffix}`
  const externalTeamId = `uoa-team-profile-${suffix}`
  const email = `profile-sync-${suffix}@example.com`
  const uoaSub = `uoa-sub-profile-${suffix}`
  t.after(async () => {
    await prisma.user.deleteMany({ where: { email } })
    await prisma.organization.deleteMany({ where: { externalOrgId } }).catch(() => undefined)
    await prisma.$disconnect()
  })
  const team = {
    activeOrgId: externalOrgId,
    activeTeamId: externalTeamId,
    teamIds: [externalTeamId],
    teamRoles: { [externalTeamId]: 'member' },
  }

  // First login: UOA asserted no name at all, so the row is named by its
  // address rather than by a manufactured "Profile Sync".
  const first = await resolveUoaTeamContext(prisma, { email, uoaSub, team })
  assert.ok(first)
  assert.equal(
    (await prisma.organization.findUnique({
      where: { externalOrgId },
      select: { id: true },
    }))?.id,
    first.organizationId,
  )
  const provisioned = await prisma.user.findUniqueOrThrow({
    where: { id: first.userId },
    select: { avatarUrl: true, displayName: true, updatedAt: true },
  })
  assert.equal(provisioned.displayName, email)
  assert.equal(provisioned.avatarUrl, null)

  // Second login, now with a name and a picture: the mirror follows.
  const renamed = await resolveUoaTeamContext(prisma, {
    avatarUrl: 'https://uoa.test/ada.png',
    displayName: 'Ada Lovelace',
    email,
    uoaSub,
    team,
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
  const unchanged = await resolveUoaTeamContext(prisma, {
    avatarUrl: 'https://uoa.test/ada.png',
    displayName: 'Ada Lovelace',
    email,
    uoaSub,
    team,
  })
  assert.ok(unchanged)
  const quiet = await prisma.user.findUniqueOrThrow({
    where: { id: first.userId },
    select: { displayName: true, updatedAt: true },
  })
  assert.equal(quiet.displayName, 'Ada Lovelace')
  assert.equal(quiet.updatedAt.getTime(), synced.updatedAt.getTime())

  // A login that asserts no name never blanks the mirror back to the address.
  await resolveUoaTeamContext(prisma, { email, uoaSub, team })
  const preserved = await prisma.user.findUniqueOrThrow({
    where: { id: first.userId },
    select: { avatarUrl: true, displayName: true },
  })
  assert.equal(preserved.displayName, 'Ada Lovelace')
  assert.equal(preserved.avatarUrl, 'https://uoa.test/ada.png')
})

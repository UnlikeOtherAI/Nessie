import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { deriveUoaTeamDirectoryFromTeams } from '../src/services/uoa-directory-cache.js'
import { syncExternalTeamNames } from '../src/services/team-target.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

// A UOA-bound Team/Project is born with a frozen placeholder name
// `Team <externalTeamId[0:8]>`; `syncExternalTeamNames` heals it
// from the verified UOA team directory, mirroring org-name healing, so the
// cold-cache fallback (and every local team surface) renders the real label.

runDatabaseTest('team name heal rewrites Team and Project placeholders from the directory', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const externalOrgId = `uoa-heal-org-${suffix}`
  const externalTeamId = `uoa-heal-ws-${suffix}`
  const placeholder = `Team ${externalTeamId.slice(0, 8)}`
  const email = `team-heal-${suffix}@example.com`

  t.after(async () => {
    // Cascade: Organization delete removes projects → teams → members.
    await prisma.user.deleteMany({ where: { email } })
    await prisma.organization.deleteMany({ where: { externalOrgId } })
    await prisma.$disconnect()
  })

  const organization = await prisma.organization.create({
    data: { externalOrgId, name: `Organisation ${externalOrgId.slice(0, 8)}` },
    select: { id: true },
  })
  const project = await prisma.project.create({
    data: { organizationId: organization.id, name: placeholder },
    select: { id: true },
  })
  const team = await prisma.team.create({
    data: {
      projectId: project.id,
      name: placeholder,
      externalTeamId,
      externalOrgId,
    },
    select: { id: true },
  })
  const unboundTeam = await prisma.team.create({
    data: { projectId: project.id, name: 'Team zzzz' },
    select: { id: true },
  })
  const user = await prisma.user.create({
    data: { email, displayName: 'Team Heal Member' },
    select: { id: true },
  })
  await prisma.teamMember.create({
    data: { teamId: team.id, userId: user.id, role: 'member' },
  })

  const directory = [{
    organizationId: externalOrgId,
    teamId: externalTeamId,
    label: 'UnlikeOtherAI',
    orgName: 'UOA Org',
  }]

  // 1. The placeholder is healed on both the Team and its owning Project.
  await syncExternalTeamNames(prisma, directory)
  assert.equal(
    (await prisma.team.findUniqueOrThrow({ where: { id: team.id } })).name,
    'UnlikeOtherAI',
  )
  assert.equal(
    (await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).name,
    'UnlikeOtherAI',
  )

  // 2. Idempotent — a second pass is a no-op, not an error.
  await syncExternalTeamNames(prisma, directory)
  assert.equal(
    (await prisma.team.findUniqueOrThrow({ where: { id: team.id } })).name,
    'UnlikeOtherAI',
  )

  // 3. A team with no external team binding is never touched.
  assert.equal(
    (await prisma.team.findUniqueOrThrow({ where: { id: unboundTeam.id } })).name,
    'Team zzzz',
  )

  // 4. A blank label must never blank a real name.
  await syncExternalTeamNames(prisma, [{
    organizationId: externalOrgId,
    teamId: externalTeamId,
    label: '   ',
    orgName: 'UOA Org',
  }])
  assert.equal(
    (await prisma.team.findUniqueOrThrow({ where: { id: team.id } })).name,
    'UnlikeOtherAI',
  )

  // 5. The cold-cache fallback — the actual client-facing path that carried
  // the bug — now returns the healed label.
  const fallback = await deriveUoaTeamDirectoryFromTeams(prisma, user.id)
  assert.equal(fallback.entries[0]?.label, 'UnlikeOtherAI')
})

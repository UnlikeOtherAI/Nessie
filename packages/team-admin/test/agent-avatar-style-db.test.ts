import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { writeScopedSetting } from '@nessie/runtime'
import { AGENT_AVATAR_STYLE_SETTING_KEY } from '@nessie/schemas'

import {
  resolveAgentAvatarStyle,
  resolveAgentAvatarStyleSafely,
  styleForGeneration,
  writeAgentAvatarStyle,
} from '../src/index.js'

/**
 * The remembered portrait style, against the real cascade.
 *
 * A preference stated once in a design conversation has to survive it, which is
 * why this is a `ScopedSetting` and not a memory — so what is worth proving is
 * that it behaves like every other setting: the person's own value wins, an
 * organisation may pin a house style, and a pinned one refuses the person's
 * write instead of silently keeping a value that will never be used.
 *
 * Cleanup is scoped to this suite's own organisation: no global delete, no
 * global count assertion.
 */

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

type Seed = { organizationId: string; userId: string }
type SeedWithTeam = Seed & { projectId: string; teamId: string }

const seed = async (prisma: PrismaClient): Promise<SeedWithTeam> => {
  const suffix = randomUUID()
  const user = await prisma.user.create({
    data: { displayName: 'Stylist', email: `avatar-style-${suffix}@example.test` },
  })
  const organization = await prisma.organization.create({
    data: { name: `avatar-style-${suffix}` },
  })
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, role: 'owner', userId: user.id },
  })
  const project = await prisma.project.create({
    data: { name: `avatar-style-${suffix}`, organizationId: organization.id },
  })
  const team = await prisma.team.create({
    data: { name: `avatar-style-${suffix}`, projectId: project.id },
  })
  return {
    organizationId: organization.id,
    projectId: project.id,
    teamId: team.id,
    userId: user.id,
  }
}

const cleanup = async (prisma: PrismaClient, seeded: SeedWithTeam) => {
  await prisma.scopedSetting.deleteMany({
    where: { organizationId: seeded.organizationId },
  })
  await prisma.team.deleteMany({ where: { id: seeded.teamId } })
  await prisma.project.deleteMany({ where: { id: seeded.projectId } })
  await prisma.organizationMember.deleteMany({ where: { userId: seeded.userId } })
  await prisma.organization.deleteMany({ where: { id: seeded.organizationId } })
  await prisma.user.deleteMany({ where: { id: seeded.userId } })
}

const withDb = async (
  run: (prisma: PrismaClient, seeded: SeedWithTeam) => Promise<void>,
) => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    await run(prisma, seeded)
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
}

runDatabaseTest('nobody has chosen a style until somebody says one', async () => {
  await withDb(async (prisma, seeded) => {
    assert.deepEqual(await resolveAgentAvatarStyle(prisma, seeded), {
      lockedAtScope: null,
      style: null,
    })

    await writeAgentAvatarStyle(prisma, { ...seeded, style: 'hand-drawn cartoon' })
    assert.equal(
      (await resolveAgentAvatarStyle(prisma, seeded)).style,
      'hand-drawn cartoon',
    )

    // Stating a new one replaces it; a person has one style, not a history.
    await writeAgentAvatarStyle(prisma, { ...seeded, style: 'photorealistic' })
    assert.equal((await resolveAgentAvatarStyle(prisma, seeded)).style, 'photorealistic')
  })
})

runDatabaseTest('an organisation house style is inherited until a person overrides it', async () => {
  await withDb(async (prisma, seeded) => {
    await writeScopedSetting(prisma, {
      key: AGENT_AVATAR_STYLE_SETTING_KEY,
      locked: false,
      organizationId: seeded.organizationId,
      scope: 'organization',
      updatedByUserId: seeded.userId,
      value: 'flat corporate illustration',
    })
    assert.equal(
      (await resolveAgentAvatarStyle(prisma, seeded)).style,
      'flat corporate illustration',
    )

    await writeAgentAvatarStyle(prisma, { ...seeded, style: 'watercolour' })
    assert.equal((await resolveAgentAvatarStyle(prisma, seeded)).style, 'watercolour')
  })
})

runDatabaseTest('a locked house style refuses the person’s own write', async () => {
  await withDb(async (prisma, seeded) => {
    await writeScopedSetting(prisma, {
      key: AGENT_AVATAR_STYLE_SETTING_KEY,
      locked: true,
      organizationId: seeded.organizationId,
      scope: 'organization',
      updatedByUserId: seeded.userId,
      value: 'flat corporate illustration',
    })

    const resolved = await resolveAgentAvatarStyle(prisma, seeded)
    assert.equal(resolved.style, 'flat corporate illustration')
    assert.equal(resolved.lockedAtScope, 'organization')

    await assert.rejects(
      writeAgentAvatarStyle(prisma, { ...seeded, style: 'watercolour' }),
      /set at the organisation level/,
    )
    // The refusal is the whole point: the portrait still follows the house.
    assert.equal(
      (await resolveAgentAvatarStyle(prisma, seeded)).style,
      'flat corporate illustration',
    )
  })
})

runDatabaseTest('a TEAM lock is refused too, which the shared write cannot see', async () => {
  await withDb(async (prisma, seeded) => {
    await writeScopedSetting(prisma, {
      key: AGENT_AVATAR_STYLE_SETTING_KEY,
      locked: true,
      organizationId: seeded.organizationId,
      scope: 'team',
      teamId: seeded.teamId,
      updatedByUserId: seeded.userId,
      value: 'team house style',
    })

    // `writeScopedSetting` is given no team on a personal write — a person may
    // be in several — so this lock is invisible to it, and the check that
    // catches it lives beside the caller that knows which team is in play.
    assert.equal(
      (await resolveAgentAvatarStyle(prisma, seeded)).lockedAtScope,
      'team',
    )
    await assert.rejects(
      writeAgentAvatarStyle(prisma, { ...seeded, style: 'watercolour' }),
      /set at the team level/,
    )
    assert.equal(
      (await resolveAgentAvatarStyle(prisma, seeded)).style,
      'team house style',
    )
  })
})

runDatabaseTest('a stored value that is not a style never reaches an image prompt', async () => {
  await withDb(async (prisma, seeded) => {
    await writeScopedSetting(prisma, {
      key: AGENT_AVATAR_STYLE_SETTING_KEY,
      locked: false,
      organizationId: seeded.organizationId,
      scope: 'user',
      updatedByUserId: seeded.userId,
      userId: seeded.userId,
      value: { not: 'a style' },
    })
    assert.equal((await resolveAgentAvatarStyle(prisma, seeded)).style, null)
    assert.equal(await resolveAgentAvatarStyleSafely(prisma, seeded), null)
  })
})

test('a pinned style decides the picture, not just whether it is remembered', () => {
  // Pure rule, so it is provable without a Ledger image endpoint: a lock above
  // the person wins over whatever style the conversation asked for.
  assert.deepEqual(
    styleForGeneration({ lockedAtScope: 'organization', style: 'flat vector' }, 'photoreal'),
    { pinned: true, style: 'flat vector' },
  )
  assert.deepEqual(
    styleForGeneration({ lockedAtScope: 'team', style: 'flat vector' }, 'photoreal'),
    { pinned: true, style: 'flat vector' },
  )
  // A person's own lock is not above them; their request still wins.
  assert.deepEqual(
    styleForGeneration({ lockedAtScope: 'user', style: 'flat vector' }, 'photoreal'),
    { pinned: false, style: 'photoreal' },
  )
  assert.deepEqual(
    styleForGeneration({ lockedAtScope: null, style: 'cartoon' }, undefined),
    { pinned: false, style: 'cartoon' },
  )
  assert.deepEqual(
    styleForGeneration({ lockedAtScope: null, style: null }, undefined),
    { pinned: false, style: null },
  )
})

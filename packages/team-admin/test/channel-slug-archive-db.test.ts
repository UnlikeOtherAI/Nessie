import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import {
  ChannelSlugConflictError,
  createChannelForUser,
  createProjectForUser,
  setChannelArchived,
  updateChannel,
} from '../src/index.js'

/**
 * What an archived channel does and does not hold on to.
 *
 * `DELETE /api/channels/:id` archives, and every list a person can see hides
 * archived channels — so a name held by one is held by something invisible.
 * These run against the real partial unique index precisely because that index
 * is half of the rule: a check that let the name through while the constraint
 * refused it would be a 500, not a fix.
 */

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

type Seed = {
  organizationId: string
  ownerId: string
  teamId: string
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const suffix = randomUUID()
  const owner = await prisma.user.create({
    data: { displayName: 'Owner', email: `slug-archive-${suffix}@example.test` },
  })
  const organization = await prisma.organization.create({
    data: { name: `slug-archive-${suffix}` },
  })
  const anchorProject = await prisma.project.create({
    data: { name: `slug-archive-anchor-${suffix}`, organizationId: organization.id },
  })
  const team = await prisma.team.create({
    data: { name: `slug-archive-team-${suffix}`, projectId: anchorProject.id },
  })
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, role: 'owner', userId: owner.id },
  })
  await prisma.teamMember.create({
    data: { role: 'owner', teamId: team.id, userId: owner.id },
  })
  return { organizationId: organization.id, ownerId: owner.id, teamId: team.id }
}

const cleanup = async (prisma: PrismaClient, seeded: Seed): Promise<void> => {
  await prisma.organization.deleteMany({ where: { id: seeded.organizationId } })
  await prisma.user.deleteMany({ where: { id: seeded.ownerId } })
}

runDatabaseTest('an archived shared channel releases its name', async (t) => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  t.after(() => cleanup(prisma, seeded).then(() => prisma.$disconnect()))

  const first = await createChannelForUser(prisma, {
    label: 'random',
    organizationId: seeded.organizationId,
    scope: 'standalone',
    userId: seeded.ownerId,
    visibility: 'public',
  })
  assert.ok(first)

  // The name is taken while the channel is visible.
  await assert.rejects(
    createChannelForUser(prisma, {
      label: 'random',
      organizationId: seeded.organizationId,
      scope: 'standalone',
      userId: seeded.ownerId,
      visibility: 'public',
    }),
    (error: unknown) => error instanceof ChannelSlugConflictError
      && error.message === 'A standalone channel with slug "random" already exists',
  )

  // Archiving is what `DELETE /api/channels/:id` does. The name comes back.
  const archived = await setChannelArchived(prisma, {
    archived: true,
    channelId: first.id,
    organizationId: seeded.organizationId,
    userId: seeded.ownerId,
  })
  assert.ok(archived?.archivedAt)

  const second = await createChannelForUser(prisma, {
    label: 'random',
    organizationId: seeded.organizationId,
    scope: 'standalone',
    userId: seeded.ownerId,
    visibility: 'public',
  })
  assert.ok(second)
  assert.notEqual(second.id, first.id)
  assert.equal(second.slug, 'random')
})

runDatabaseTest('unarchiving into a taken name is refused in words', async (t) => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  t.after(() => cleanup(prisma, seeded).then(() => prisma.$disconnect()))

  const first = await createChannelForUser(prisma, {
    label: 'random',
    organizationId: seeded.organizationId,
    scope: 'standalone',
    userId: seeded.ownerId,
    visibility: 'public',
  })
  assert.ok(first)
  await setChannelArchived(prisma, {
    archived: true,
    channelId: first.id,
    organizationId: seeded.organizationId,
    userId: seeded.ownerId,
  })
  await createChannelForUser(prisma, {
    label: 'random',
    organizationId: seeded.organizationId,
    scope: 'standalone',
    userId: seeded.ownerId,
    visibility: 'public',
  })

  await assert.rejects(
    setChannelArchived(prisma, {
      archived: false,
      channelId: first.id,
      organizationId: seeded.organizationId,
      userId: seeded.ownerId,
    }),
    (error: unknown) => error instanceof ChannelSlugConflictError
      && error.message === 'A standalone channel with slug "random" already exists.'
        + ' Rename that channel, or rename this one, before unarchiving',
  )

  // Refused, not half-applied: the channel is still archived.
  const stillArchived = await prisma.channel.findUniqueOrThrow({
    where: { id: first.id },
    select: { archivedAt: true },
  })
  assert.notEqual(stillArchived.archivedAt, null)

  // Renaming the live one frees the name, and the restore then goes through.
  const live = await prisma.channel.findFirstOrThrow({
    where: { archivedAt: null, organizationId: seeded.organizationId, slug: 'random' },
    select: { id: true },
  })
  await updateChannel(prisma, {
    channelId: live.id,
    label: 'random-two',
    organizationId: seeded.organizationId,
    userId: seeded.ownerId,
  })
  const restored = await setChannelArchived(prisma, {
    archived: false,
    channelId: first.id,
    organizationId: seeded.organizationId,
    userId: seeded.ownerId,
  })
  assert.equal(restored?.archivedAt, null)
})

runDatabaseTest('the shared list and a project keep separate names', async (t) => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  t.after(() => cleanup(prisma, seeded).then(() => prisma.$disconnect()))

  const shared = await createChannelForUser(prisma, {
    label: 'general',
    organizationId: seeded.organizationId,
    scope: 'standalone',
    userId: seeded.ownerId,
    visibility: 'public',
  })
  assert.ok(shared)

  const project = await createProjectForUser(prisma, {
    name: 'Marketing',
    organizationId: seeded.organizationId,
    teamId: seeded.teamId,
    userId: seeded.ownerId,
  })
  // The same name in a project is a different channel, not a conflict.
  const inProject = await createChannelForUser(prisma, {
    label: 'general',
    organizationId: seeded.organizationId,
    projectId: project.id,
    teamId: seeded.teamId,
    userId: seeded.ownerId,
    visibility: 'public',
  })
  assert.ok(inProject)
  assert.equal(inProject.scope, 'project')
  assert.equal(shared.scope, 'standalone')

  // Twice within one project is still a conflict, and it names that project.
  await assert.rejects(
    createChannelForUser(prisma, {
      label: 'general',
      organizationId: seeded.organizationId,
      projectId: project.id,
      teamId: seeded.teamId,
      userId: seeded.ownerId,
      visibility: 'public',
    }),
    (error: unknown) => error instanceof ChannelSlugConflictError
      && error.message === 'A channel with slug "general" already exists in this project',
  )
})

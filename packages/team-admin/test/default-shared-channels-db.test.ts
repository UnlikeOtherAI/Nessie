import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import {
  ensureSharedChannelRootInTransaction,
  setChannelArchived,
} from '../src/index.js'

/**
 * A new organisation's "Shared channels" is never empty: #general and #random
 * arrive with the channel root. Deleting one is final, because the seed is
 * keyed on the root, not on the channels.
 */

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

const sharedChannels = (prisma: PrismaClient, organizationId: string) =>
  prisma.channel.findMany({
    where: { archivedAt: null, organizationId, project: { channelRoot: true } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, label: true, slug: true, visibility: true },
  })

runDatabaseTest('the channel root seeds #general and #random once, and a deleted one stays deleted', async () => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const owner = await prisma.user.create({
    data: { displayName: 'Owner', email: `default-shared-${suffix}@example.test` },
  })
  const organization = await prisma.organization.create({
    data: { name: `default-shared-${suffix}` },
  })
  try {
    await prisma.organizationMember.create({
      data: { organizationId: organization.id, role: 'owner', userId: owner.id },
    })
    await prisma.$transaction((tx) => ensureSharedChannelRootInTransaction(tx, organization.id))

    const seeded = await sharedChannels(prisma, organization.id)
    assert.deepEqual(
      seeded.map((channel) => [channel.label, channel.slug, channel.visibility]),
      [['general', 'general', 'public'], ['random', 'random', 'public']],
    )

    const random = seeded.find((channel) => channel.slug === 'random')!
    await setChannelArchived(prisma, {
      archived: true,
      channelId: random.id,
      organizationId: organization.id,
      userId: owner.id,
    })

    // A second resolve — the next organisation materialization, or a person
    // creating a shared channel — must not bring #random back.
    await prisma.$transaction((tx) => ensureSharedChannelRootInTransaction(tx, organization.id))
    assert.deepEqual(
      (await sharedChannels(prisma, organization.id)).map((channel) => channel.slug),
      ['general'],
    )
  } finally {
    await prisma.organization.deleteMany({ where: { id: organization.id } })
    await prisma.user.deleteMany({ where: { id: owner.id } })
    await prisma.$disconnect()
  }
})

runDatabaseTest('a root an older release created empty is seeded on the next resolve', async () => {
  const prisma = new PrismaClient()
  const organization = await prisma.organization.create({
    data: { name: `default-shared-empty-root-${randomUUID()}` },
  })
  try {
    const project = await prisma.project.create({
      data: { channelRoot: true, name: 'Standalone channels', organizationId: organization.id },
    })
    await prisma.team.create({
      data: { name: 'Standalone channels', projectId: project.id, systemManaged: true },
    })

    await prisma.$transaction((tx) => ensureSharedChannelRootInTransaction(tx, organization.id))

    assert.deepEqual(
      (await sharedChannels(prisma, organization.id)).map((channel) => channel.slug),
      ['general', 'random'],
    )
  } finally {
    await prisma.organization.deleteMany({ where: { id: organization.id } })
    await prisma.$disconnect()
  }
})

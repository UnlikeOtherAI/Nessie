import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import type { SpaceViewer } from '../src/access.js'
import { buildKnowledgeRoot } from '../src/native-root.js'
import { createNativeKnowledgeProvider } from '../src/native-provider.js'

/**
 * The root column's project rows (data-and-api.md §7). Two things broke
 * together: the root listed `viewer.projectIds` (memberships only) while
 * `GET /api/projects` lists every live project for an organisation
 * owner/admin, so an owner's own project had no folder; and a project's
 * Documents space waited for a first open, so the row that did appear could
 * be a `project-unopened` placeholder. The root now takes the caller's
 * accessible-project read and provisions every listed project's folder
 * itself.
 *
 * A DB test because every part of the contract is a row: the space that must
 * exist after the read, exactly once, and the channel-root/deleted projects
 * that must not become rows at all.
 */
const dbTest = process.env.DATABASE_URL ? test : test.skip

const memberViewer = (userId: string, projectIds: string[]): SpaceViewer => ({
  baseEntitled: true,
  bypass: false,
  organizationRole: 'member',
  uoaMembershipVerified: false,
  userId,
  projectIds: new Set(projectIds),
  visibleAgentIds: new Set(),
})

dbTest('the root provisions every accessible project’s folder, once, and mirrors the project filters', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const email = `kb-root-build-${suffix}@test.local`
  let organizationId: string | null = null
  t.after(async () => {
    if (organizationId) await prisma.organization.deleteMany({ where: { id: organizationId } })
    await prisma.user.deleteMany({ where: { email } })
    await prisma.$disconnect()
  })

  const organization = await prisma.organization.create({ data: { name: `kb-root-build-${suffix}` } })
  organizationId = organization.id
  const user = await prisma.user.create({ data: { displayName: 'Root reader', email } })
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, role: 'member', userId: user.id },
  })
  const [apollo, sales, anchor, deleted] = await Promise.all([
    prisma.project.create({ data: { name: `Apollo-${suffix.slice(0, 6)}`, organizationId: organization.id } }),
    prisma.project.create({ data: { name: `Sales-${suffix.slice(0, 6)}`, organizationId: organization.id } }),
    prisma.project.create({
      data: { channelRoot: true, name: `Anchor-${suffix.slice(0, 6)}`, organizationId: organization.id },
    }),
    prisma.project.create({
      data: { deletedAt: new Date(), name: `Gone-${suffix.slice(0, 6)}`, organizationId: organization.id },
    }),
  ])
  await prisma.projectMember.create({
    data: { projectId: apollo.id, role: 'owner', userId: user.id },
  })

  const provider = createNativeKnowledgeProvider(prisma)
  const build = (accessibleProjectIds: string[] | 'all') => buildKnowledgeRoot(prisma, {
    accessibleProjectIds,
    canManageAccess: () => false,
    organizationId: organization.id,
    projectId: apollo.id,
    provider,
    userId: user.id,
    viewer: memberViewer(user.id, [apollo.id]),
  })

  // A member's read: their one project, with its folder provisioned by the
  // read itself rather than by a first click on a placeholder row.
  const first = await build([apollo.id])
  assert.equal(first.root.projects.length, 1)
  assert.equal(first.root.projects[0]?.projectId, apollo.id)
  const apolloSpaceId = first.root.projects[0]?.space.spaceId
  assert.ok(apolloSpaceId)
  assert.equal(first.root.projects[0]?.space.name, 'Project Documents')
  // The project's Documents folder is never also a shared folder.
  assert.equal(first.root.shared.some((space) => space.spaceId === apolloSpaceId), false)

  // A repeat read is idempotent: the same space, and still exactly one.
  const again = await build([apollo.id])
  assert.equal(again.root.projects[0]?.space.spaceId, apolloSpaceId)
  const apolloSpaces = await prisma.knowledgeSpace.count({
    where: {
      deletedAt: null,
      metadata: { path: ['projectDocuments'], equals: true },
      organizationId: organization.id,
      projectId: apollo.id,
    },
  })
  assert.equal(apolloSpaces, 1, 'the advisory-locked ensure must not double-create')

  // An organisation owner/admin's read ('all'): Sales has a folder even
  // though the viewer holds no membership in it — the two surfaces agree.
  // The channel-root anchor and the deleted project stay out, mirroring
  // listProjectsForUser's filters.
  const owners = await build('all')
  assert.deepEqual(
    owners.root.projects.map((project) => project.projectId).sort(),
    [apollo.id, sales.id].sort(),
  )
  const salesRow = owners.root.projects.find((project) => project.projectId === sales.id)
  assert.ok(salesRow?.space.spaceId, 'an owner’s non-member project still has its folder')
  assert.equal(owners.root.projects.some((project) => project.projectId === anchor.id), false)
  assert.equal(owners.root.projects.some((project) => project.projectId === deleted.id), false)
})

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { createNativeKnowledgeProvider } from '../src/native-provider.js'
import { KnowledgeConflictError } from '../src/errors.js'

/**
 * Renaming a folder.
 *
 * `updatePage` decided "does this create a version?" from the fields that
 * changed, with no arm for the folder kind, and a created version carried a
 * `status: 'draft'` write with it. So renaming a folder — the F2 the Finder's
 * menu offers on every folder row — wrote a version row for a page that has no
 * content and quietly unpublished it. `publishPage` refuses a folder outright,
 * so there was no way back: one rename turned a published folder into a
 * permanent draft, with a version row underneath it that nothing can render.
 *
 * This is a DB test rather than a unit one because every part of the defect is
 * a row: the version that should not exist, and the status that should not
 * have moved. A stub would have agreed with the broken code.
 */
const dbTest = process.env.DATABASE_URL ? test : test.skip

dbTest('renaming a folder changes its name and nothing else', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const email = `kb-folder-rename-${suffix}@test.local`
  let organizationId: string | null = null
  t.after(async () => {
    if (organizationId) {
      await prisma.organization.deleteMany({ where: { id: organizationId } })
    }
    await prisma.user.deleteMany({ where: { email } })
    await prisma.$disconnect()
  })

  const organization = await prisma.organization.create({
    data: { name: `kb-folder-rename-${suffix}` },
  })
  organizationId = organization.id
  const user = await prisma.user.create({ data: { displayName: 'Folder owner', email } })
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, userId: user.id },
  })
  const project = await prisma.project.create({
    data: { name: `kb-folder-rename-project-${suffix}`, organizationId: organization.id },
  })
  const space = await prisma.knowledgeSpace.create({
    data: {
      createdBy: user.id,
      name: `kb-folder-rename-space-${suffix}`,
      organizationId: organization.id,
      projectId: project.id,
      visibility: 'project',
    },
  })

  const provider = createNativeKnowledgeProvider(prisma)
  const folder = await provider.createPage({
    authorId: user.id,
    authorType: 'user',
    createdBy: user.id,
    kind: 'folder',
    organizationId: organization.id,
    projectId: project.id,
    spaceId: space.id,
    title: 'Contracts',
  })
  assert.equal(folder.kind, 'folder')
  // A folder is born published with nothing under it: there is no content to
  // review, so there is no draft state for it to be in.
  assert.equal(folder.status, 'published')
  assert.equal(
    await prisma.knowledgePageVersion.count({ where: { pageId: folder.id } }),
    0,
    'a folder has no version to begin with',
  )

  const renamed = await provider.updatePage(folder.id, {
    authorId: user.id,
    authorType: 'user',
    organizationId: organization.id,
    title: 'Contracts 2026',
  })

  assert.equal(renamed?.title, 'Contracts 2026')
  assert.equal(renamed?.kind, 'folder')
  // The two facts the defect moved.
  assert.equal(renamed?.status, 'published', 'a rename must not unpublish a folder')
  assert.equal(
    await prisma.knowledgePageVersion.count({ where: { pageId: folder.id } }),
    0,
    'a folder rename must not write a version row',
  )
  // The rename itself still counts as a save, so a stale tab is still refused.
  assert.equal(renamed?.revision, folder.revision + 1)

  // And a document in the same space keeps the behaviour the folder arm is an
  // exception to: its rename is a content change, so it does version and does
  // return to draft for a person to publish.
  const document = await provider.createPage({
    authorId: user.id,
    authorType: 'user',
    body: 'first',
    createdBy: user.id,
    organizationId: organization.id,
    projectId: project.id,
    spaceId: space.id,
    title: 'Plan',
  })
  const renamedDocument = await provider.updatePage(document.id, {
    authorId: user.id,
    authorType: 'user',
    organizationId: organization.id,
    title: 'Plan 2026',
  })
  assert.equal(renamedDocument?.status, 'draft')
  assert.equal(await prisma.knowledgePageVersion.count({ where: { pageId: document.id } }), 2)
})

dbTest('a folder still refuses content on the update path, as it does on create', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const email = `kb-folder-body-${suffix}@test.local`
  let organizationId: string | null = null
  t.after(async () => {
    if (organizationId) {
      await prisma.organization.deleteMany({ where: { id: organizationId } })
    }
    await prisma.user.deleteMany({ where: { email } })
    await prisma.$disconnect()
  })

  const organization = await prisma.organization.create({
    data: { name: `kb-folder-body-${suffix}` },
  })
  organizationId = organization.id
  const user = await prisma.user.create({ data: { displayName: 'Folder owner', email } })
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, userId: user.id },
  })
  const project = await prisma.project.create({
    data: { name: `kb-folder-body-project-${suffix}`, organizationId: organization.id },
  })
  const space = await prisma.knowledgeSpace.create({
    data: {
      createdBy: user.id,
      name: `kb-folder-body-space-${suffix}`,
      organizationId: organization.id,
      projectId: project.id,
      visibility: 'project',
    },
  })

  const provider = createNativeKnowledgeProvider(prisma)
  const folder = await provider.createPage({
    authorId: user.id,
    authorType: 'user',
    createdBy: user.id,
    kind: 'folder',
    organizationId: organization.id,
    projectId: project.id,
    spaceId: space.id,
    title: 'Contracts',
  })

  // Refusing is the point: dropping the body silently would lose it with no
  // way for the caller to notice, which is the reason `createPage` refuses too.
  await assert.rejects(
    provider.updatePage(folder.id, {
      authorId: user.id,
      authorType: 'user',
      body: '<p>not allowed</p>',
      organizationId: organization.id,
    }),
    (error: unknown) => {
      assert.ok(error instanceof KnowledgeConflictError)
      return true
    },
  )
  assert.equal(await prisma.knowledgePageVersion.count({ where: { pageId: folder.id } }), 0)
})

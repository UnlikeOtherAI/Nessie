import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { createNativeKnowledgeProvider } from '../src/native-provider.js'
import { collectTransferSubtree, loadTransferSpaceScope } from '../src/transfer/collect.js'
import { planTransferCopy } from '../src/transfer/copy.js'
import type { KnowledgeVersionCreatedEvent, NativeKnowledgeProviderOptions } from '../src/version-events.js'

/**
 * `onVersionCreated`: the one "a version exists now" signal document triggers
 * open their quiet window from (docs/standards/document-triggers.md). Every
 * canonical writer announces its version inside the save; nothing that is not
 * somebody editing a document does — a folder, a metadata-only edit, a
 * transfer copy, a migration's version.
 */
const dbTest = process.env.DATABASE_URL ? test : test.skip

dbTest('every writer announces its version, and nothing else does', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const email = `kb-version-events-${suffix}@test.local`
  let organizationId: string | null = null
  t.after(async () => {
    if (organizationId) await prisma.organization.deleteMany({ where: { id: organizationId } })
    await prisma.user.deleteMany({ where: { email } })
    await prisma.$disconnect()
  })

  const organization = await prisma.organization.create({ data: { name: `kb-version-events-${suffix}` } })
  organizationId = organization.id
  const user = await prisma.user.create({ data: { displayName: 'Writer', email } })
  await prisma.organizationMember.create({ data: { organizationId: organization.id, userId: user.id } })
  const project = await prisma.project.create({
    data: { name: `kb-version-events-project-${suffix}`, organizationId: organization.id },
  })
  const space = await prisma.knowledgeSpace.create({
    data: {
      createdBy: user.id,
      name: `kb-version-events-space-${suffix}`,
      organizationId: organization.id,
      projectId: project.id,
      visibility: 'project',
    },
  })
  const target = await prisma.knowledgeSpace.create({
    data: {
      createdBy: user.id,
      name: `kb-version-events-target-${suffix}`,
      organizationId: organization.id,
      projectId: project.id,
      visibility: 'project',
    },
  })

  const events: KnowledgeVersionCreatedEvent[] = []
  const options: NativeKnowledgeProviderOptions = {
    onVersionCreated: async (tx, event) => {
      // Inside the save: the version is already visible to the transaction.
      assert.ok(await tx.knowledgePageVersion.findUnique({ where: { id: event.versionId } }))
      events.push(event)
    },
  }
  const provider = createNativeKnowledgeProvider(prisma, options)
  const scope = {
    authorId: user.id,
    authorType: 'user' as const,
    createdBy: user.id,
    organizationId: organization.id,
    projectId: project.id,
    spaceId: space.id,
  }

  const folder = await provider.createPage({ ...scope, kind: 'folder', title: 'Specs' })
  assert.equal(events.length, 0, 'a folder has no version to announce')

  const page = await provider.createPage({ ...scope, body: '<p>One</p>', parentPageId: folder.id, title: 'Login spec' })
  assert.deepEqual(events.map((event) => [event.pageId, event.versionNumber, event.kind]), [[page.id, 1, 'document']])
  assert.equal(events[0]!.projectId, project.id)
  assert.equal(events[0]!.spaceId, space.id)
  assert.equal(events[0]!.authorType, 'user')
  assert.equal(events[0]!.authorId, user.id)
  assert.equal(events[0]!.origin, 'user_authored')

  await provider.updatePage(page.id, { ...scope, body: '<p>Two</p>' })
  assert.equal(events.at(-1)?.versionNumber, 2, 'updatePage announces the version it wrote')
  const before = events.length
  await provider.updatePage(page.id, { ...scope, metadata: { pinned: true } })
  assert.equal(events.length, before, 'a metadata-only edit writes no version and announces none')

  const firstVersion = await prisma.knowledgePageVersion.findFirstOrThrow({ where: { pageId: page.id, versionNumber: 1 } })
  await provider.restoreVersion({ ...scope, pageId: page.id, versionId: firstVersion.id })
  assert.equal(events.at(-1)?.versionNumber, 3, 'restoreVersion announces the version it wrote')

  const attachment = await prisma.attachment.create({
    data: {
      organizationId: organization.id,
      uploaderId: user.id,
      kind: 'file',
      mime: 'application/pdf',
      filename: 'contract.pdf',
      sizeBytes: 12n,
      storageKey: `test/${randomUUID()}`,
    },
  })
  const file = await provider.createPage({ ...scope, attachmentId: attachment.id, kind: 'file', title: 'contract.pdf' })
  assert.deepEqual([events.at(-1)?.pageId, events.at(-1)?.kind], [file.id, 'file'])
  const second = await prisma.attachment.create({
    data: {
      organizationId: organization.id,
      uploaderId: user.id,
      kind: 'file',
      mime: 'application/pdf',
      filename: 'contract.pdf',
      sizeBytes: 14n,
      storageKey: `test/${randomUUID()}`,
    },
  })
  await provider.addFileVersion({ ...scope, attachmentId: second.id, pageId: file.id })
  assert.deepEqual([events.at(-1)?.pageId, events.at(-1)?.versionNumber], [file.id, 2], 'addFileVersion announces its version')

  // A migration's version is not an edit, whichever writer carried it.
  const count = events.length
  await provider.updatePage(page.id, { ...scope, body: '<p>Migrated</p>', origin: 'legacy_migration' })
  assert.equal(events.length, count, 'a legacy_migration version is not announced')

  // A copy writes its versions without the writer: the copied document was not edited.
  await prisma.$transaction(async (tx) => {
    const nodes = await collectTransferSubtree(tx, { organizationId: organization.id, pageIds: [page.id] })
    const targetScope = await loadTransferSpaceScope(tx, organization.id, target.id)
    assert.ok(targetScope)
    const plan = await planTransferCopy(tx, {
      organizationId: organization.id,
      targetSpace: targetScope,
      nodes,
      parentPageId: null,
      startPosition: 0,
      actor: { actorId: user.id, actorType: 'user' },
      sourceSpaceName: space.name,
      providerOptions: options,
    })
    assert.equal(plan.idMap.length, 1)
  })
  assert.equal(events.length, count, 'a transfer copy announces nothing')
  assert.equal(await prisma.knowledgePage.count({ where: { spaceId: target.id } }), 1, 'the copy exists')
})

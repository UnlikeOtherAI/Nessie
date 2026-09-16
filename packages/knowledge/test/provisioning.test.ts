import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { createNativeKnowledgeProvider } from '../src/native-provider.js'
import {
  ensureAgentDocsSpace,
  ensureProjectDocumentsSpace,
  ensureTaskFolder,
} from '../src/provisioning.js'

const dbTest = process.env.DATABASE_URL ? test : test.skip

const createAgentHomeFixture = async (prisma: PrismaClient, suffix: string) => {
  const organization = await prisma.organization.create({
    data: { name: `agent-doc-provision-${suffix}` },
  })
  const project = await prisma.project.create({
    data: { name: `agent-doc-provision-project-${suffix}`, organizationId: organization.id },
  })
  const agent = await prisma.agent.create({
    data: {
      name: `Documents agent ${suffix}`,
      organizationId: organization.id,
      role: 'researcher',
    },
  })
  return { agent, organization, project }
}

dbTest('ensureAgentDocsSpace serializes concurrent provisioning into one valid home', async (t) => {
  const prisma = new PrismaClient()
  const { agent, organization, project } = await createAgentHomeFixture(prisma, randomUUID())
  t.after(async () => {
    await prisma.organization.delete({ where: { id: organization.id } })
    await prisma.$disconnect()
  })

  const input = {
    agentId: agent.id,
    agentName: agent.name,
    organizationId: organization.id,
    projectId: project.id,
  }
  const [first, second] = await Promise.all([
    ensureAgentDocsSpace(prisma, input),
    ensureAgentDocsSpace(prisma, input),
  ])

  assert.equal(first.spaceId, second.spaceId)
  assert.deepEqual([first.created, second.created].sort(), [false, true])

  const homes = await prisma.knowledgeSpace.findMany({
    where: { organizationId: organization.id, ownerAgentId: agent.id, deletedAt: null },
    select: {
      id: true,
      metadata: true,
      ownerAgentId: true,
      privateToAgentId: true,
      visibility: true,
    },
  })
  assert.equal(homes.length, 1, 'the advisory lock must prevent duplicate homes')
  assert.deepEqual(homes[0], {
    id: first.spaceId,
    metadata: { agentDocs: true },
    ownerAgentId: agent.id,
    privateToAgentId: null,
    visibility: 'private',
  })
})

dbTest('ensureAgentDocsSpace refuses a system-managed agent', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const organization = await prisma.organization.create({
    data: { name: `system-agent-doc-provision-${suffix}` },
  })
  const project = await prisma.project.create({
    data: { name: `system-agent-doc-project-${suffix}`, organizationId: organization.id },
  })
  const agent = await prisma.agent.create({
    data: {
      name: `Personal Assistant ${suffix}`,
      organizationId: organization.id,
      role: 'assistant',
      systemManaged: true,
    },
  })
  t.after(async () => {
    await prisma.organization.delete({ where: { id: organization.id } })
    await prisma.$disconnect()
  })

  await assert.rejects(
    ensureAgentDocsSpace(prisma, {
      agentId: agent.id,
      agentName: agent.name,
      organizationId: organization.id,
      projectId: project.id,
    }),
    /system-managed/i,
  )
  assert.equal(
    await prisma.knowledgeSpace.count({
      where: { organizationId: organization.id, ownerAgentId: agent.id },
    }),
    0,
  )
})

// ── ensureTaskFolder: the folder kind, end to end ───────────────────────────
//
// A folder is `kind: 'folder'` and nothing else. The convention it replaced —
// `metadata.folder === true || childrenOf(page).length > 0` — is retired, so a
// writer that still used it would produce a page every kind-reading consumer
// calls a document. These cases run the real writer against Postgres because
// that is the only place the answer lives: `createPage` refuses content on a
// folder, forces `status: 'published'` and writes no version row, and a stub
// provider would assert nothing but its own return value.
//
// `finderIsFolder` is the Finder's predicate, verbatim. In the admin it is
// spelled `page.kind === 'folder'` at
// `admin/src/components/features/knowledge/finder/FinderFolderColumn.tsx`
// (`isFolder`), `FinderListView.tsx`, `DocumentsFinder.tsx` and
// `finder-sort.ts`. It cannot be imported across the package boundary, so it
// is restated here and must stay identical to those.
const finderIsFolder = (page: { kind: string }): boolean => page.kind === 'folder'

const createTaskFolderFixture = async (prisma: PrismaClient, suffix: string) => {
  const organization = await prisma.organization.create({
    data: { name: `task-folder-${suffix}` },
  })
  const user = await prisma.user.create({
    data: { displayName: 'Ticket owner', email: `task-folder-${suffix}@test.local` },
  })
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, userId: user.id },
  })
  const project = await prisma.project.create({
    data: { name: `task-folder-project-${suffix}`, organizationId: organization.id },
  })
  const task = await prisma.task.create({
    data: {
      organizationId: organization.id,
      projectId: project.id,
      title: 'Fix the boiler',
    },
  })
  const { spaceId } = await ensureProjectDocumentsSpace(prisma, {
    actorId: user.id,
    organizationId: organization.id,
    projectId: project.id,
  })
  const provider = createNativeKnowledgeProvider(prisma)
  const input = {
    actorId: user.id,
    authorType: 'user' as const,
    organizationId: organization.id,
    projectId: project.id,
    spaceId,
    task: { id: task.id, title: task.title },
  }
  return { input, organization, project, provider, spaceId, task, user }
}

dbTest('ensureTaskFolder writes a real folder, not the retired convention', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const email = `task-folder-${suffix}@test.local`
  const { input, organization, provider } = await createTaskFolderFixture(prisma, suffix)
  t.after(async () => {
    await prisma.organization.delete({ where: { id: organization.id } })
    await prisma.user.deleteMany({ where: { email } })
    await prisma.$disconnect()
  })

  const folderId = await ensureTaskFolder(prisma, provider, input)
  const folder = await prisma.knowledgePage.findFirstOrThrow({
    where: { id: folderId },
    select: {
      kind: true,
      metadata: true,
      publishedVersionId: true,
      status: true,
      taskId: true,
      title: true,
      _count: { select: { versions: true } },
    },
  })

  // The predicate first: this is the split-brain the kind exists to prevent,
  // and it is the assertion that must fail if a writer regresses.
  assert.ok(finderIsFolder(folder), "the Finder's own predicate must see a folder")
  assert.equal(folder.kind, 'folder')
  assert.equal(folder.title, 'Fix the boiler')
  // The flag is gone, the ticket binding is not: `metadata.taskId` is what
  // makes the idempotent lookup exact and the column is what the ticket's
  // document list is keyed by.
  assert.deepEqual(folder.metadata, { taskId: input.task.id })
  assert.equal(folder.taskId, input.task.id)
  // No version, never a draft, nothing to publish.
  assert.equal(folder._count.versions, 0)
  assert.equal(folder.status, 'published')
  assert.equal(folder.publishedVersionId, null)
})

dbTest('ensureTaskFolder finds its own folder again, not the documents inside it', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const email = `task-folder-${suffix}@test.local`
  const { input, organization, project, provider, spaceId } =
    await createTaskFolderFixture(prisma, suffix)
  t.after(async () => {
    await prisma.organization.delete({ where: { id: organization.id } })
    await prisma.user.deleteMany({ where: { email } })
    await prisma.$disconnect()
  })

  const folderId = await ensureTaskFolder(prisma, provider, input)

  // Exactly what `POST /api/knowledge-base/tasks/:taskId/pages` does next: a
  // ticket document filed under the folder, carrying the same `taskId` column.
  // A lookup that had drifted to the column would find this row on the second
  // ensure and hand the route a document to file everything under.
  const document = await provider.createPage({
    authorId: input.actorId,
    authorType: 'user',
    body: '<p>Bleed the radiators first.</p>',
    createdBy: input.actorId,
    organizationId: organization.id,
    parentPageId: folderId,
    projectId: project.id,
    spaceId,
    taskId: input.task.id,
    title: 'Boiler notes',
  })
  assert.equal(document.kind, 'document')
  assert.equal(finderIsFolder(document), false, 'a document with a folder parent is not a folder')

  const again = await ensureTaskFolder(prisma, provider, input)
  assert.equal(again, folderId)
  assert.equal(
    await prisma.knowledgePage.count({
      where: { spaceId, kind: 'folder', deletedAt: null },
    }),
    1,
    'a second ensure must not create a second folder',
  )

  // The retired rule said a document with children is a folder. It has
  // children now; it is still a document.
  const parent = await provider.createPage({
    authorId: input.actorId,
    authorType: 'user',
    body: '<p>Parent</p>',
    createdBy: input.actorId,
    organizationId: organization.id,
    projectId: project.id,
    spaceId,
    title: 'Has sub-pages',
  })
  await provider.createPage({
    authorId: input.actorId,
    authorType: 'user',
    body: '<p>Child</p>',
    createdBy: input.actorId,
    organizationId: organization.id,
    parentPageId: parent.id,
    projectId: project.id,
    spaceId,
    title: 'A sub-page',
  })
  const reread = await provider.getPage(organization.id, parent.id)
  assert.ok(reread)
  assert.equal(finderIsFolder(reread), false, 'having children must not make a document a folder')
})

dbTest('a folder refuses content and refuses to be published', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const email = `task-folder-${suffix}@test.local`
  const { input, organization, provider } = await createTaskFolderFixture(prisma, suffix)
  t.after(async () => {
    await prisma.organization.delete({ where: { id: organization.id } })
    await prisma.user.deleteMany({ where: { email } })
    await prisma.$disconnect()
  })

  const folderId = await ensureTaskFolder(prisma, provider, input)

  // `publishPage` throws rather than returning null, so a caller that maps
  // null to 404 now answers 409. The API's publish route catches it through
  // `sendKnowledgeMutationError`; this pins the thrown shape that relies on.
  await assert.rejects(
    provider.publishPage({ organizationId: organization.id, pageId: folderId }),
    /nothing to publish/i,
  )

  await assert.rejects(
    provider.createPage({
      authorId: input.actorId,
      authorType: 'user',
      body: '<p>Folders have no body.</p>',
      createdBy: input.actorId,
      kind: 'folder',
      organizationId: organization.id,
      projectId: input.projectId,
      spaceId: input.spaceId,
      title: 'Not allowed',
    }),
    /cannot carry content/i,
  )
})

dbTest('a page may be filed under a folder or a document, never under a file', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const email = `task-folder-${suffix}@test.local`
  const { input, organization, project, provider, spaceId, user } =
    await createTaskFolderFixture(prisma, suffix)
  t.after(async () => {
    await prisma.organization.delete({ where: { id: organization.id } })
    await prisma.user.deleteMany({ where: { email } })
    await prisma.$disconnect()
  })

  const scope = {
    authorId: user.id,
    authorType: 'user' as const,
    createdBy: user.id,
    organizationId: organization.id,
    projectId: project.id,
    spaceId,
  }
  const folderId = await ensureTaskFolder(prisma, provider, input)
  const document = await provider.createPage({ ...scope, body: '<p>Body</p>', title: 'Parent doc' })
  const attachment = await prisma.attachment.create({
    data: {
      filename: 'contract.pdf',
      kind: 'file',
      mime: 'application/pdf',
      organizationId: organization.id,
      sizeBytes: 12n,
      storageKey: `test/${randomUUID()}`,
      uploaderId: user.id,
    },
  })
  const fileNode = await provider.createPage({
    ...scope,
    attachmentId: attachment.id,
    kind: 'file',
    title: 'contract.pdf',
  })
  const subject = await provider.createPage({ ...scope, body: '<p>Move me</p>', title: 'Subject' })

  const intoFolder = await provider.movePage({
    organizationId: organization.id,
    pageId: subject.id,
    parentPageId: folderId,
    position: 0,
  })
  assert.equal(intoFolder?.parentPageId, folderId)

  // A document still parents sub-pages: wikilinks and the open document's
  // Sub-pages section depend on it, and the Finder simply does not open a
  // column for one.
  const intoDocument = await provider.movePage({
    organizationId: organization.id,
    pageId: subject.id,
    parentPageId: document.id,
    position: 0,
  })
  assert.equal(intoDocument?.parentPageId, document.id)

  // A file node is a blob. `movePage` refuses by returning null — the same
  // value it returns for "no such page" — which is why `kb_file` reads the
  // target's kind itself and names the reason.
  const intoFile = await provider.movePage({
    organizationId: organization.id,
    pageId: subject.id,
    parentPageId: fileNode.id,
    position: 0,
  })
  assert.equal(intoFile, null)
  const unmoved = await provider.getPage(organization.id, subject.id)
  assert.equal(unmoved?.parentPageId, document.id, 'a refused move must change nothing')
})

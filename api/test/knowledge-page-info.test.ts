import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import Fastify from 'fastify'
import { PrismaClient } from '@prisma/client'
import {
  createNativeKnowledgeProvider,
  getKnowledgePageInfo,
  loadSpaceViewer,
} from '@nessie/knowledge'
import type { AuthorizedActionContext, KnowledgeItemInfo } from '@nessie/schemas'

import { registerKnowledgeFinderRoutes } from '../src/routes/knowledge-finder.js'
import { seedDefaultPolicies } from '../src/services/policy-seed.js'

/**
 * Get Info's size is the whole subtree's, joined through each page's current
 * version to its attachment's `sizeBytes` — a BigInt that crosses the wire as a
 * decimal string. Only a real database can prove the recursive walk, the
 * version choice and the BigInt handling; a stub would just echo a number back.
 *
 * Contract: docs/plans/2026-09-16-documents-finder-ui/data-and-api.md §5.
 */
const dbTest = process.env.DATABASE_URL ? test : test.skip

const SPACE_LEDGER_BYTES = 9999n
const DOCUMENT_BODY = '<p>Payment terms</p>'

dbTest('Get Info adds up everything inside, and refuses a stranger', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const emails = [
    `kb-info-alice-${suffix}@test.local`,
    `kb-info-carol-${suffix}@test.local`,
  ]
  let organizationId: string | null = null
  t.after(async () => {
    if (organizationId) await prisma.organization.deleteMany({ where: { id: organizationId } })
    await prisma.user.deleteMany({ where: { email: { in: emails } } })
    await prisma.$disconnect()
  })

  const organization = await prisma.organization.create({ data: { name: `kb-info-${suffix}` } })
  organizationId = organization.id
  const [alice, carol] = await Promise.all(emails.map((email, index) =>
    prisma.user.create({ data: { email, displayName: index === 0 ? 'Alice' : 'Carol' } })))
  await prisma.organizationMember.createMany({
    data: [
      { organizationId: organization.id, userId: alice.id, role: 'member' },
      { organizationId: organization.id, userId: carol.id, role: 'member' },
    ],
  })
  const project = await prisma.project.create({
    data: { name: `kb-info-project-${suffix}`, organizationId: organization.id },
  })
  await prisma.projectMember.create({
    data: { projectId: project.id, userId: alice.id, role: 'owner' },
  })
  await seedDefaultPolicies(prisma, organization.id, alice.id)
  const space = await prisma.knowledgeSpace.create({
    data: {
      createdBy: alice.id,
      name: 'Team folder',
      organizationId: organization.id,
      projectId: project.id,
      visibility: 'project',
    },
  })

  const provider = createNativeKnowledgeProvider(prisma)
  const scope = {
    authorId: alice.id,
    authorType: 'user' as const,
    createdBy: alice.id,
    organizationId: organization.id,
    projectId: project.id,
    spaceId: space.id,
  }
  const storeAttachment = (sizeBytes: bigint) => prisma.attachment.create({
    data: {
      organizationId: organization.id,
      uploaderId: alice.id,
      kind: 'file',
      mime: 'application/pdf',
      filename: 'contract.pdf',
      sizeBytes,
      storageKey: `test/${randomUUID()}`,
    },
  })

  const folder = await provider.createPage({ ...scope, kind: 'folder', title: 'Contracts' })
  await provider.createPage({
    ...scope,
    parentPageId: folder.id,
    body: DOCUMENT_BODY,
    title: 'Terms',
  })
  const firstBlob = await storeAttachment(400n)
  const file = await provider.createPage({
    ...scope,
    parentPageId: folder.id,
    kind: 'file',
    attachmentId: firstBlob.id,
    title: 'contract.pdf',
  })
  // A second version: the current one is what "Size" counts, the older one is
  // still on disk and is what `retainedVersions` names.
  const secondBlob = await storeAttachment(1234n)
  await provider.addFileVersion({
    organizationId: organization.id,
    pageId: file.id,
    attachmentId: secondBlob.id,
    authorId: alice.id,
    authorType: 'user',
  })

  const app = Fastify({ logger: false })
  const contextFor = (userId: string): AuthorizedActionContext => ({
    actionContext: { requestId: `kb-info-${userId}` },
    actor: { actorId: userId, actorType: 'user', roles: ['member'] },
    tenant: { organizationId: organization.id, projectId: project.id },
  }) as AuthorizedActionContext
  const actors = new Map([['alice', contextFor(alice.id)], ['carol', contextFor(carol.id)]])
  registerKnowledgeFinderRoutes(app, {
    prisma,
    knowledgeProvider: provider,
    fileService: { usageForScope: async () => SPACE_LEDGER_BYTES },
    isProjectAccessibleToActor: async () => true,
    requireActorContext: (request: { headers: Record<string, unknown> }) => {
      const actor = request.headers['x-kb-info-actor']
      return typeof actor === 'string' ? actors.get(actor) : undefined
    },
  } as unknown as Parameters<typeof registerKnowledgeFinderRoutes>[1])

  const infoAs = (actor: string, url: string) => app.inject({
    method: 'GET',
    url,
    headers: { 'x-kb-info-actor': actor },
  })

  const folderResponse = await infoAs('alice', `/api/knowledge-base/pages/${folder.id}/info`)
  assert.equal(folderResponse.statusCode, 200, folderResponse.body)
  const folderInfo = (folderResponse.json() as { data: KnowledgeItemInfo }).data
  assert.equal(folderInfo.target, 'page')
  assert.equal(folderInfo.kind, 'folder')
  // The document's body plus the file's *current* version. A BigInt as a string.
  assert.equal(folderInfo.sizeBytes, String(DOCUMENT_BODY.length + 1234))
  // On disk keeps the superseded version too.
  assert.equal(folderInfo.storageBytes, String(DOCUMENT_BODY.length + 1234 + 400))
  assert.equal(folderInfo.retainedVersions, 1)
  // Spreadsheets are counted in their own right — Get Info says "1 document,
  // 1 file" of a folder holding neither a folder nor a workbook.
  assert.deepEqual(folderInfo.counts, { folders: 0, documents: 1, files: 1, spreadsheets: 0 })
  assert.equal(folderInfo.truncated, false)
  assert.equal(folderInfo.home.spaceId, space.id)
  assert.equal(folderInfo.home.rootKind, 'shared')
  assert.deepEqual(folderInfo.home.parentPath, [])
  assert.equal(folderInfo.access.mode, 'space')
  assert.equal(folderInfo.mime, null)

  const fileResponse = await infoAs('alice', `/api/knowledge-base/pages/${file.id}/info`)
  assert.equal(fileResponse.statusCode, 200, fileResponse.body)
  const fileInfo = (fileResponse.json() as { data: KnowledgeItemInfo }).data
  assert.equal(fileInfo.sizeBytes, '1234')
  assert.equal(fileInfo.mime, 'application/pdf')
  assert.deepEqual(fileInfo.counts, { folders: 0, documents: 0, files: 0, spreadsheets: 0 })

  const spaceResponse = await infoAs('alice', `/api/knowledge-base/spaces/${space.id}/info`)
  assert.equal(spaceResponse.statusCode, 200, spaceResponse.body)
  const spaceInfo = (spaceResponse.json() as { data: KnowledgeItemInfo }).data
  assert.equal(spaceInfo.target, 'space')
  assert.equal(spaceInfo.kind, 'space')
  // For a space the ledger is the authority on what the quota charges.
  assert.equal(spaceInfo.storageBytes, SPACE_LEDGER_BYTES.toString())
  assert.deepEqual(spaceInfo.counts, { folders: 1, documents: 1, files: 1, spreadsheets: 0 })

  // Carol is in the organisation but not in the project: the space is not hers
  // to read, and Get Info must not describe it to her.
  const refused = await infoAs('carol', `/api/knowledge-base/pages/${folder.id}/info`)
  assert.equal(refused.statusCode, 403, refused.body)
  const refusedSpace = await infoAs('carol', `/api/knowledge-base/spaces/${space.id}/info`)
  assert.equal(refusedSpace.statusCode, 403, refusedSpace.body)

  // The walk is bounded, and it says so when it stops early rather than
  // reporting a total it did not finish computing.
  const viewer = await loadSpaceViewer(prisma, organization.id, {
    actorType: 'user',
    actorId: alice.id,
  })
  const loadedSpace = await provider.getSpace(organization.id, space.id)
  const loadedFolder = await provider.getPage(organization.id, folder.id)
  assert.ok(loadedSpace && loadedFolder)
  const capped = await getKnowledgePageInfo(prisma, {
    organizationId: organization.id,
    page: loadedFolder,
    space: loadedSpace,
    viewer,
    canManageAccess: false,
    rowCap: 2,
  })
  assert.equal(capped.truncated, true)
  // Lower bounds: two of the three rows were walked.
  assert.equal(capped.counts.documents + capped.counts.files, 1)
})

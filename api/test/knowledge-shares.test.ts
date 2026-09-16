import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import Fastify from 'fastify'
import { PrismaClient } from '@prisma/client'
import { createNativeKnowledgeProvider, ensureMyDocsSpace } from '@nessie/knowledge'
import type { AuthorizedActionContext } from '@nessie/schemas'
import { registerKnowledgeBaseRoutes } from '../src/routes/knowledge-base.js'
import { registerKnowledgeShareRoutes } from '../src/routes/knowledge-shares.js'
import { registerKnowledgeSharedWithMeRoutes } from '../src/routes/knowledge-shared-with-me.js'
import { seedDefaultPolicies } from '../src/services/policy-seed.js'

/**
 * Person-to-person sharing, against a real database with three actors: the
 * owner, the person they shared with, and a third colleague who was granted
 * nothing.
 *
 * The third actor is the point. Every assertion about the grantee has a
 * mirror-image assertion about the stranger, because an access rule that is
 * only tested from the granted side cannot tell "the share works" apart from
 * "everybody can read it".
 *
 * A cast Prisma fake cannot stand in here: the share arm is a recursive SQL
 * walk, so a stub would answer for the shape of the call rather than for the
 * rule, and a missing delegate surfaces as a TypeError disguised as a 401.
 */

const dbTest = process.env.DATABASE_URL ? test : test.skip

type Seed = {
  granteeId: string
  organizationId: string
  ownerId: string
  personalSpaceId: string
  prisma: PrismaClient
  projectId: string
  projectSpaceId: string
  strangerId: string
  userIds: string[]
}

const seed = async (): Promise<Seed> => {
  const prisma = new PrismaClient()
  const organizationId = randomUUID()
  const ownerId = randomUUID()
  const granteeId = randomUUID()
  const strangerId = randomUUID()
  const userIds = [ownerId, granteeId, strangerId]

  await prisma.organization.create({ data: { id: organizationId, name: `kb-shares-${organizationId}` } })
  await prisma.user.createMany({
    data: userIds.map((id, index) => ({
      id,
      email: `${id}@kb-shares.test`,
      displayName: ['Olivia Owner', 'Greta Grantee', 'Sam Stranger'][index],
    })),
  })
  await prisma.organizationMember.createMany({
    data: [
      { organizationId, userId: ownerId, role: 'owner' },
      { organizationId, userId: granteeId, role: 'member' },
      { organizationId, userId: strangerId, role: 'member' },
    ],
  })
  const project = await prisma.project.create({ data: { organizationId, name: 'Shares' } })
  await prisma.projectMember.createMany({
    data: userIds.map((userId) => ({ projectId: project.id, userId, role: 'member' as const })),
  })
  await seedDefaultPolicies(prisma, organizationId, ownerId)

  const personal = await ensureMyDocsSpace(prisma, {
    organizationId,
    projectId: project.id,
    userId: ownerId,
  })
  const projectSpace = await prisma.knowledgeSpace.create({
    data: {
      name: 'Project documents',
      organizationId,
      projectId: project.id,
      visibility: 'project',
      createdBy: ownerId,
      metadata: { projectDocuments: true },
    },
    select: { id: true },
  })

  return {
    granteeId,
    organizationId,
    ownerId,
    personalSpaceId: personal.spaceId,
    prisma,
    projectId: project.id,
    projectSpaceId: projectSpace.id,
    strangerId,
    userIds,
  }
}

const teardown = async (seeded: Seed): Promise<void> => {
  await seeded.prisma.organization.deleteMany({ where: { id: seeded.organizationId } })
  await seeded.prisma.user.deleteMany({ where: { id: { in: seeded.userIds } } })
  await seeded.prisma.$disconnect()
}

type ActorName = 'owner' | 'grantee' | 'stranger'

const buildApp = (seeded: Seed) => {
  const contextFor = (userId: string, role: 'member' | 'owner'): AuthorizedActionContext => ({
    actionContext: { requestId: `kb-shares-${userId}` },
    actor: { actorId: userId, actorType: 'user', roles: [role] },
    tenant: { organizationId: seeded.organizationId, projectId: seeded.projectId },
  }) as AuthorizedActionContext

  const actors = new Map<string, AuthorizedActionContext>([
    ['owner', contextFor(seeded.ownerId, 'owner')],
    ['grantee', contextFor(seeded.granteeId, 'member')],
    ['stranger', contextFor(seeded.strangerId, 'member')],
  ])
  const app = Fastify({ logger: false })
  const deps = {
    prisma: seeded.prisma,
    knowledgeProvider: createNativeKnowledgeProvider(seeded.prisma),
    // Archiving purges the page's stored files first; no test page has any.
    fileService: { purgeKnowledgePageFiles: async () => undefined },
    requireActorContext: (request: { headers: Record<string, unknown> }) => {
      const actor = request.headers['x-kb-shares-actor']
      return typeof actor === 'string' ? actors.get(actor) : undefined
    },
  } as unknown as Parameters<typeof registerKnowledgeBaseRoutes>[1]
  registerKnowledgeBaseRoutes(app, deps)
  registerKnowledgeShareRoutes(app, deps)
  registerKnowledgeSharedWithMeRoutes(app, deps)

  const as = (actor: ActorName, input: Parameters<typeof app.inject>[0]) => app.inject({
    ...input,
    headers: { ...input.headers, 'x-kb-shares-actor': actor },
  })
  return { app, as }
}

const dataOf = <T>(response: { json: () => unknown }): T => (response.json() as { data: T }).data
const errorCode = (response: { json: () => unknown }): string =>
  (response.json() as { error: { code: string } }).error.code

dbTest('a page share reaches one subtree, for one person, and never becomes a space grant', async () => {
  const seeded = await seed()
  const { app, as } = buildApp(seeded)
  try {
    const folder = await as('owner', {
      method: 'POST',
      url: `/api/knowledge-base/spaces/${seeded.personalSpaceId}/pages`,
      payload: { title: 'Contracts', kind: 'folder' },
    })
    assert.equal(folder.statusCode, 201)
    const folderId = dataOf<{ id: string }>(folder).id

    const child = await as('owner', {
      method: 'POST',
      url: `/api/knowledge-base/spaces/${seeded.personalSpaceId}/pages`,
      payload: { title: 'Lease', body: '<p>Terms</p>', parentPageId: folderId },
    })
    assert.equal(child.statusCode, 201)
    const childId = dataOf<{ id: string }>(child).id

    const sibling = await as('owner', {
      method: 'POST',
      url: `/api/knowledge-base/spaces/${seeded.personalSpaceId}/pages`,
      payload: { title: 'Private note', body: '<p>Not shared</p>' },
    })
    assert.equal(sibling.statusCode, 201)
    const siblingId = dataOf<{ id: string }>(sibling).id

    // Before any share, neither colleague reaches the owner's personal space.
    for (const actor of ['grantee', 'stranger'] as const) {
      const denied = await as(actor, { method: 'GET', url: `/api/knowledge-base/pages/${childId}` })
      assert.equal(denied.statusCode, 403, `${actor} must not read before a share`)
    }

    const share = await as('owner', {
      method: 'POST',
      url: `/api/knowledge-base/pages/${folderId}/shares`,
      payload: { granteeUserId: seeded.granteeId },
    })
    assert.equal(share.statusCode, 201)
    assert.equal(dataOf<{ access: string }>(share).access, 'view')

    // A folder share covers its descendants, resolved by the walk…
    const granteeReads = await as('grantee', {
      method: 'GET',
      url: `/api/knowledge-base/pages/${childId}`,
    })
    assert.equal(granteeReads.statusCode, 200)
    // …and nothing else in the owner's space.
    const outsideTheFolder = await as('grantee', {
      method: 'GET',
      url: `/api/knowledge-base/pages/${siblingId}`,
    })
    assert.equal(outsideTheFolder.statusCode, 403)
    // The third actor was granted nothing and must see exactly that.
    const strangerReads = await as('stranger', {
      method: 'GET',
      url: `/api/knowledge-base/pages/${childId}`,
    })
    assert.equal(strangerReads.statusCode, 403)

    // `view` is not a write grant.
    const viewerWrites = await as('grantee', {
      method: 'PATCH',
      url: `/api/knowledge-base/pages/${childId}`,
      payload: { body: '<p>Edited by a viewer</p>' },
    })
    assert.equal(viewerWrites.statusCode, 403)

    const raised = await as('owner', {
      method: 'PATCH',
      url: `/api/knowledge-base/pages/${folderId}/shares/${seeded.granteeId}`,
      payload: { access: 'edit' },
    })
    assert.equal(raised.statusCode, 200)
    assert.equal(dataOf<{ access: string }>(raised).access, 'edit')

    const editorWrites = await as('grantee', {
      method: 'PATCH',
      url: `/api/knowledge-base/pages/${childId}`,
      payload: { body: '<p>Edited by the recipient</p>' },
    })
    assert.equal(editorWrites.statusCode, 200)
    const storedVersion = await seeded.prisma.knowledgePageVersion.findFirst({
      where: { pageId: childId },
      orderBy: { versionNumber: 'desc' },
      select: { authorId: true, authorType: true },
    })
    assert.equal(storedVersion?.authorId, seeded.granteeId)
    assert.equal(storedVersion?.authorType, 'user')

    // An edit grant is still not write access to the space: the sibling outside
    // the shared folder stays the owner's alone.
    const editorWritesOutside = await as('grantee', {
      method: 'PATCH',
      url: `/api/knowledge-base/pages/${siblingId}`,
      payload: { body: '<p>Not allowed</p>' },
    })
    assert.equal(editorWritesOutside.statusCode, 403)
    const editorCreatesAtSpaceRoot = await as('grantee', {
      method: 'POST',
      url: `/api/knowledge-base/spaces/${seeded.personalSpaceId}/pages`,
      payload: { title: 'At the root' },
    })
    assert.equal(editorCreatesAtSpaceRoot.statusCode, 403)

    // …but creating inside the shared folder is writing inside the grant.
    const editorCreatesInside = await as('grantee', {
      method: 'POST',
      url: `/api/knowledge-base/spaces/${seeded.personalSpaceId}/pages`,
      payload: { title: 'Addendum', parentPageId: folderId },
    })
    assert.equal(editorCreatesInside.statusCode, 201)
    assert.equal(dataOf<{ createdBy: string }>(editorCreatesInside).createdBy, seeded.granteeId)
    const strangerCreatesInside = await as('stranger', {
      method: 'POST',
      url: `/api/knowledge-base/spaces/${seeded.personalSpaceId}/pages`,
      payload: { title: 'Uninvited', parentPageId: folderId },
    })
    assert.equal(strangerCreatesInside.statusCode, 403)

    // The four acts that stay the owner's however generously they shared.
    const publish = await as('grantee', {
      method: 'POST',
      url: `/api/knowledge-base/pages/${childId}/publish`,
    })
    assert.equal(publish.statusCode, 403)
    const move = await as('grantee', {
      method: 'POST',
      url: `/api/knowledge-base/pages/${childId}/move`,
      payload: { parentPageId: null, position: 0 },
    })
    assert.equal(move.statusCode, 403)
    const remove = await as('grantee', {
      method: 'DELETE',
      url: `/api/knowledge-base/pages/${childId}`,
    })
    assert.equal(remove.statusCode, 403)
    const reshare = await as('grantee', {
      method: 'POST',
      url: `/api/knowledge-base/pages/${childId}/shares`,
      payload: { granteeUserId: seeded.strangerId },
    })
    assert.equal(reshare.statusCode, 403)
    assert.equal(errorCode(reshare), 'SHARE_NOT_PERSONAL')

    // Who else holds a share is the owner's to know.
    const granteeListsShares = await as('grantee', {
      method: 'GET',
      url: `/api/knowledge-base/pages/${folderId}/shares`,
    })
    assert.equal(granteeListsShares.statusCode, 403)
    const strangerListsShares = await as('stranger', {
      method: 'GET',
      url: `/api/knowledge-base/pages/${folderId}/shares`,
    })
    assert.equal(strangerListsShares.statusCode, 403)
    assert.equal(
      errorCode(strangerListsShares),
      errorCode(granteeListsShares),
      'a grantee must get the same refusal as a stranger, or the list discloses them',
    )
    const ownerListsShares = await as('owner', {
      method: 'GET',
      url: `/api/knowledge-base/pages/${folderId}/shares`,
    })
    assert.equal(ownerListsShares.statusCode, 200)
    assert.equal(dataOf<unknown[]>(ownerListsShares).length, 1)

    // Opening a shared folder lists its children although the space is private.
    const withoutTheParam = await as('grantee', {
      method: 'GET',
      url: `/api/knowledge-base/spaces/${seeded.personalSpaceId}/pages`,
    })
    assert.equal(withoutTheParam.statusCode, 403)
    const subtree = await as('grantee', {
      method: 'GET',
      url: `/api/knowledge-base/spaces/${seeded.personalSpaceId}/pages?sharedRootPageId=${folderId}`,
    })
    assert.equal(subtree.statusCode, 200)
    const subtreeIds = dataOf<{ id: string }[]>(subtree).map((row) => row.id)
    assert.ok(subtreeIds.includes(folderId) && subtreeIds.includes(childId))
    assert.ok(!subtreeIds.includes(siblingId), 'the subtree must stop at the shared folder')
    const strangerSubtree = await as('stranger', {
      method: 'GET',
      url: `/api/knowledge-base/spaces/${seeded.personalSpaceId}/pages?sharedRootPageId=${folderId}`,
    })
    assert.equal(strangerSubtree.statusCode, 403)

    // Shared with me: one row for the folder, for the grantee only.
    const granteeInbox = await as('grantee', {
      method: 'GET',
      url: '/api/knowledge-base/shared-with-me',
    })
    assert.equal(granteeInbox.statusCode, 200)
    const inboxRows = dataOf<{ id: string; kind: string; access: string; home: { spaceName: string } }[]>(granteeInbox)
    assert.equal(inboxRows.length, 1)
    assert.equal(inboxRows[0]?.id, folderId)
    assert.equal(inboxRows[0]?.kind, 'folder')
    assert.equal(inboxRows[0]?.access, 'edit')
    assert.equal(inboxRows[0]?.home.spaceName, 'My Docs')
    const strangerInbox = await as('stranger', {
      method: 'GET',
      url: '/api/knowledge-base/shared-with-me',
    })
    assert.equal(dataOf<unknown[]>(strangerInbox).length, 0)

    // The share took effect on the next read and opened no approval.
    const approvals = await seeded.prisma.approvalRequest.count({
      where: { organizationId: seeded.organizationId },
    })
    assert.equal(approvals, 0, 'a person-to-person share is never an approval')
    const audits = await seeded.prisma.auditLog.findMany({
      where: { organizationId: seeded.organizationId, resourceId: folderId },
      select: { action: true },
    })
    const actions = new Set(audits.map((entry) => entry.action))
    assert.ok(actions.has('kb.page.shared'))
    assert.ok(actions.has('kb.page.share_changed'))

    // The grantee may decline; nobody else may revoke for them.
    const strangerRevokes = await as('stranger', {
      method: 'DELETE',
      url: `/api/knowledge-base/pages/${folderId}/shares/${seeded.granteeId}`,
    })
    assert.equal(strangerRevokes.statusCode, 403)
    const declines = await as('grantee', {
      method: 'DELETE',
      url: `/api/knowledge-base/pages/${folderId}/shares/${seeded.granteeId}`,
    })
    assert.equal(declines.statusCode, 204)
    const afterDecline = await as('grantee', {
      method: 'GET',
      url: `/api/knowledge-base/pages/${childId}`,
    })
    assert.equal(afterDecline.statusCode, 403)
    const unshared = await seeded.prisma.auditLog.findFirst({
      where: {
        organizationId: seeded.organizationId,
        resourceId: folderId,
        action: 'kb.page.unshared',
      },
      select: { metadata: true },
    })
    assert.equal((unshared?.metadata as { by?: string } | null)?.by, 'grantee')
  } finally {
    await app.close()
    await teardown(seeded)
  }
})

dbTest('the share routes refuse what is not a personal document, not a member, or already gone', async () => {
  const seeded = await seed()
  const { app, as } = buildApp(seeded)
  try {
    const personal = await as('owner', {
      method: 'POST',
      url: `/api/knowledge-base/spaces/${seeded.personalSpaceId}/pages`,
      payload: { title: 'Notes', body: '<p>Mine</p>' },
    })
    const personalId = dataOf<{ id: string }>(personal).id

    const projectPage = await as('owner', {
      method: 'POST',
      url: `/api/knowledge-base/spaces/${seeded.projectSpaceId}/pages`,
      payload: { title: 'Runbook', body: '<p>Ours</p>' },
    })
    assert.equal(projectPage.statusCode, 201)
    const projectPageId = dataOf<{ id: string }>(projectPage).id

    // A project's audience is its membership, read out — never granted away.
    const shareProjectPage = await as('owner', {
      method: 'POST',
      url: `/api/knowledge-base/pages/${projectPageId}/shares`,
      payload: { granteeUserId: seeded.granteeId },
    })
    assert.equal(shareProjectPage.statusCode, 403)
    assert.equal(errorCode(shareProjectPage), 'SHARE_NOT_PERSONAL')

    const shareWithSelf = await as('owner', {
      method: 'POST',
      url: `/api/knowledge-base/pages/${personalId}/shares`,
      payload: { granteeUserId: seeded.ownerId },
    })
    assert.equal(shareWithSelf.statusCode, 400)
    assert.equal(errorCode(shareWithSelf), 'SHARE_SELF')

    const shareWithOutsider = await as('owner', {
      method: 'POST',
      url: `/api/knowledge-base/pages/${personalId}/shares`,
      payload: { granteeUserId: randomUUID() },
    })
    assert.equal(shareWithOutsider.statusCode, 404)
    assert.equal(errorCode(shareWithOutsider), 'USER_NOT_FOUND')

    const patchMissingShare = await as('owner', {
      method: 'PATCH',
      url: `/api/knowledge-base/pages/${personalId}/shares/${seeded.granteeId}`,
      payload: { access: 'edit' },
    })
    assert.equal(patchMissingShare.statusCode, 404)

    // Creating twice is the change-level path, not a duplicate row.
    const first = await as('owner', {
      method: 'POST',
      url: `/api/knowledge-base/pages/${personalId}/shares`,
      payload: { granteeUserId: seeded.granteeId },
    })
    assert.equal(first.statusCode, 201)
    const again = await as('owner', {
      method: 'POST',
      url: `/api/knowledge-base/pages/${personalId}/shares`,
      payload: { granteeUserId: seeded.granteeId, access: 'edit' },
    })
    assert.equal(again.statusCode, 200)
    assert.equal(dataOf<{ id: string }>(again).id, dataOf<{ id: string }>(first).id)
    assert.equal(dataOf<{ access: string }>(again).access, 'edit')
    assert.equal(
      await seeded.prisma.knowledgePageShare.count({ where: { pageId: personalId } }),
      1,
    )

    // Archiving ends the grantee's access without anybody revoking a row.
    const archived = await as('owner', {
      method: 'DELETE',
      url: `/api/knowledge-base/pages/${personalId}`,
    })
    assert.equal(archived.statusCode, 200)
    const afterArchive = await as('grantee', {
      method: 'GET',
      url: `/api/knowledge-base/pages/${personalId}`,
    })
    assert.equal(afterArchive.statusCode, 403)
    const inbox = await as('grantee', { method: 'GET', url: '/api/knowledge-base/shared-with-me' })
    assert.equal(dataOf<unknown[]>(inbox).length, 0)
    const shareArchived = await as('owner', {
      method: 'POST',
      url: `/api/knowledge-base/pages/${personalId}/shares`,
      payload: { granteeUserId: seeded.strangerId },
    })
    assert.equal(shareArchived.statusCode, 409)
  } finally {
    await app.close()
    await teardown(seeded)
  }
})

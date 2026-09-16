import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import Fastify from 'fastify'
import { PrismaClient } from '@prisma/client'
import { createNativeKnowledgeProvider } from '@nessie/knowledge'
import type { AuthorizedActionContext, KnowledgeRoot } from '@nessie/schemas'

import { registerKnowledgeFinderRoutes } from '../src/routes/knowledge-finder.js'
import { seedDefaultPolicies } from '../src/services/policy-seed.js'

/**
 * The root column in one read. What it must get right: My Documents is
 * provisioned rather than missing, a project folder is listed before its space
 * exists (a read must not write N spaces nobody has opened), the third group is
 * the read-time "neither personal nor a project's Documents" rule, and none of
 * it describes a folder the caller cannot read.
 *
 * Contract: docs/plans/2026-09-16-documents-finder-ui/data-and-api.md §7.
 */
const dbTest = process.env.DATABASE_URL ? test : test.skip

dbTest('the documents root names exactly the folders a person can open', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const emails = [`kb-root-alice-${suffix}@test.local`, `kb-root-carol-${suffix}@test.local`]
  let organizationId: string | null = null
  t.after(async () => {
    if (organizationId) await prisma.organization.deleteMany({ where: { id: organizationId } })
    await prisma.user.deleteMany({ where: { email: { in: emails } } })
    await prisma.$disconnect()
  })

  const organization = await prisma.organization.create({ data: { name: `kb-root-${suffix}` } })
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
    data: { name: `Apollo-${suffix.slice(0, 6)}`, organizationId: organization.id },
  })
  await prisma.projectMember.create({
    data: { projectId: project.id, userId: alice.id, role: 'owner' },
  })
  await seedDefaultPolicies(prisma, organization.id, alice.id)
  const teamSpace = await prisma.knowledgeSpace.create({
    data: {
      createdBy: alice.id,
      name: 'Team folder',
      organizationId: organization.id,
      projectId: project.id,
      visibility: 'project',
    },
  })

  const provider = createNativeKnowledgeProvider(prisma)
  const app = Fastify({ logger: false })
  const contextFor = (
    userId: string,
    actorType: 'user' | 'agent' = 'user',
  ): AuthorizedActionContext => ({
    actionContext: { requestId: `kb-root-${userId}` },
    actor: { actorId: userId, actorType, roles: ['member'] },
    tenant: { organizationId: organization.id, projectId: project.id },
  }) as AuthorizedActionContext
  const actors = new Map([
    ['alice', contextFor(alice.id)],
    ['carol', contextFor(carol.id)],
    ['agent', contextFor(randomUUID(), 'agent')],
  ])
  registerKnowledgeFinderRoutes(app, {
    prisma,
    knowledgeProvider: provider,
    fileService: { usageForScope: async () => 0n },
    isProjectAccessibleToActor: async () => true,
    requireActorContext: (request: { headers: Record<string, unknown> }) => {
      const actor = request.headers['x-kb-root-actor']
      return typeof actor === 'string' ? actors.get(actor) : undefined
    },
  } as unknown as Parameters<typeof registerKnowledgeFinderRoutes>[1])

  const rootAs = async (actor: string) => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/knowledge-base/root',
      headers: { 'x-kb-root-actor': actor },
    })
    assert.equal(response.statusCode, 200, response.body)
    return (response.json() as { data: KnowledgeRoot }).data
  }

  const first = await rootAs('alice')
  assert.ok(first.myDocuments.spaceId)
  assert.equal(first.myDocuments.canWrite, true)
  assert.equal(first.projects.length, 1)
  assert.equal(first.projects[0]?.projectId, project.id)
  // Nobody has opened the project folder yet, so no space was written for it.
  assert.equal(first.projects[0]?.space, null)
  assert.ok(first.shared.some((space) => space.spaceId === teamSpace.id))
  assert.equal(first.shared.some((space) => space.spaceId === first.myDocuments.spaceId), false)
  assert.equal(first.sharedTruncated, false)
  assert.equal(first.sharedWithMeCount, 0)
  assert.equal(first.shared[0]?.projectName, project.name)

  // A repeat read is idempotent: the same personal space, not a second one.
  const again = await rootAs('alice')
  assert.equal(again.myDocuments.spaceId, first.myDocuments.spaceId)

  const provisioned = await app.inject({
    method: 'POST',
    url: `/api/knowledge-base/projects/${project.id}/documents`,
    headers: { 'x-kb-root-actor': 'alice' },
  })
  assert.equal(provisioned.statusCode, 200, provisioned.body)
  const documentsSpaceId = (provisioned.json() as { data: { id: string } }).data.id

  const afterOpen = await rootAs('alice')
  assert.equal(afterOpen.projects[0]?.space?.spaceId, documentsSpaceId)
  // A project's Documents folder *is* the project row; it is never also a
  // shared folder.
  assert.equal(afterOpen.shared.some((space) => space.spaceId === documentsSpaceId), false)

  // A page shared with Alice is a badge on the virtual row, not a folder.
  const page = await provider.createPage({
    authorId: alice.id,
    authorType: 'user',
    createdBy: alice.id,
    organizationId: organization.id,
    projectId: project.id,
    spaceId: teamSpace.id,
    body: '<p>Shared</p>',
    title: 'Shared with Alice',
  })
  await prisma.knowledgePageShare.create({
    data: {
      organizationId: organization.id,
      pageId: page.id,
      spaceId: teamSpace.id,
      granteeUserId: alice.id,
      grantedByUserId: carol.id,
      access: 'view',
    },
  })
  assert.equal((await rootAs('alice')).sharedWithMeCount, 1)

  // Carol belongs to the organisation but to no project: no project rows, and
  // the project-visible team folder is not hers to see.
  const carolRoot = await rootAs('carol')
  assert.deepEqual(carolRoot.projects, [])
  assert.equal(carolRoot.shared.some((space) => space.spaceId === teamSpace.id), false)
  assert.notEqual(carolRoot.myDocuments.spaceId, first.myDocuments.spaceId)

  // The root is a person's view. An agent has no standing place in it.
  const agentResponse = await app.inject({
    method: 'GET',
    url: '/api/knowledge-base/root',
    headers: { 'x-kb-root-actor': 'agent' },
  })
  assert.equal(agentResponse.statusCode, 403, agentResponse.body)
  assert.equal(
    (agentResponse.json() as { error: { code: string } }).error.code,
    'ACTOR_TYPE_NOT_ALLOWED',
  )
})

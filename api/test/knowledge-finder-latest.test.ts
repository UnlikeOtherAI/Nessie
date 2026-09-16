import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import Fastify from 'fastify'
import { PrismaClient } from '@prisma/client'
import { createNativeKnowledgeProvider } from '@nessie/knowledge'
import type { AuthorizedActionContext, KnowledgeVirtualRow } from '@nessie/schemas'

import { registerKnowledgeFinderRoutes } from '../src/routes/knowledge-finder.js'
import { seedDefaultPolicies } from '../src/services/policy-seed.js'

/**
 * Latest is viewer-scoped, and that is the only thing about it that must never
 * be wrong: a listing that names a page the viewer cannot open hands them a row
 * that 403s when clicked and, worse, a title they were not entitled to read.
 *
 * Proved against a real database with two people, because the rule is SQL —
 * `readableSpaceIdsSqlForViewer` plus the shared `filterReadablePages` — and a
 * stubbed Prisma would only prove that the stub returns what it was told to.
 *
 * Contract: docs/plans/2026-09-16-documents-finder-ui/data-and-api.md §3.
 */
const dbTest = process.env.DATABASE_URL ? test : test.skip

type Seed = {
  prisma: PrismaClient
  organizationId: string
  projectId: string
  aliceId: string
  bobId: string
  emails: string[]
}

const seed = async (): Promise<Seed> => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const emails = [`kb-latest-alice-${suffix}@test.local`, `kb-latest-bob-${suffix}@test.local`]
  const organization = await prisma.organization.create({ data: { name: `kb-latest-${suffix}` } })
  const [alice, bob] = await Promise.all(emails.map((email, index) =>
    prisma.user.create({ data: { email, displayName: index === 0 ? 'Alice' : 'Bob' } })))
  await prisma.organizationMember.createMany({
    data: [
      { organizationId: organization.id, userId: alice.id, role: 'member' },
      { organizationId: organization.id, userId: bob.id, role: 'member' },
    ],
  })
  const project = await prisma.project.create({
    data: { name: `kb-latest-project-${suffix}`, organizationId: organization.id },
  })
  await prisma.projectMember.createMany({
    data: [
      { projectId: project.id, userId: alice.id, role: 'owner' },
      { projectId: project.id, userId: bob.id, role: 'member' },
    ],
  })
  await seedDefaultPolicies(prisma, organization.id, alice.id)
  return {
    prisma,
    organizationId: organization.id,
    projectId: project.id,
    aliceId: alice.id,
    bobId: bob.id,
    emails,
  }
}

const contextFor = (seeded: Seed, userId: string): AuthorizedActionContext => ({
  actionContext: { requestId: `kb-latest-${userId}` },
  actor: { actorId: userId, actorType: 'user', roles: ['member'] },
  tenant: { organizationId: seeded.organizationId, projectId: seeded.projectId },
}) as AuthorizedActionContext

dbTest('Latest shows a person only the pages they may open', async (t) => {
  const seeded = await seed()
  t.after(async () => {
    await seeded.prisma.organization.deleteMany({ where: { id: seeded.organizationId } })
    await seeded.prisma.user.deleteMany({ where: { email: { in: seeded.emails } } })
    await seeded.prisma.$disconnect()
  })
  const provider = createNativeKnowledgeProvider(seeded.prisma)

  // Alice's own private folder: she created it, nobody else is a member.
  const privateSpace = await seeded.prisma.knowledgeSpace.create({
    data: {
      createdBy: seeded.aliceId,
      name: 'Alice only',
      organizationId: seeded.organizationId,
      projectId: seeded.projectId,
      visibility: 'private',
    },
  })
  const teamSpace = await seeded.prisma.knowledgeSpace.create({
    data: {
      createdBy: seeded.aliceId,
      name: 'Team folder',
      organizationId: seeded.organizationId,
      projectId: seeded.projectId,
      visibility: 'project',
    },
  })
  const scope = {
    authorId: seeded.aliceId,
    authorType: 'user' as const,
    createdBy: seeded.aliceId,
    organizationId: seeded.organizationId,
    projectId: seeded.projectId,
  }
  const secret = await provider.createPage({
    ...scope,
    spaceId: privateSpace.id,
    body: '<p>Salary review</p>',
    title: 'Alice private note',
  })
  const folder = await provider.createPage({
    ...scope,
    spaceId: teamSpace.id,
    kind: 'folder',
    title: 'Archive',
  })
  const runbook = await provider.createPage({
    ...scope,
    spaceId: teamSpace.id,
    body: '<p>How we deploy</p>',
    title: 'Runbook',
  })
  const nested = await provider.createPage({
    ...scope,
    spaceId: teamSpace.id,
    parentPageId: folder.id,
    body: '<p>Older note</p>',
    title: 'Nested note',
  })

  const app = Fastify({ logger: false })
  const actors = new Map([
    ['alice', contextFor(seeded, seeded.aliceId)],
    ['bob', contextFor(seeded, seeded.bobId)],
  ])
  registerKnowledgeFinderRoutes(app, {
    prisma: seeded.prisma,
    knowledgeProvider: provider,
    fileService: { usageForScope: async () => 0n },
    isProjectAccessibleToActor: async () => true,
    requireActorContext: (request: { headers: Record<string, unknown> }) => {
      const actor = request.headers['x-kb-latest-actor']
      return typeof actor === 'string' ? actors.get(actor) : undefined
    },
  } as unknown as Parameters<typeof registerKnowledgeFinderRoutes>[1])

  const latestAs = async (actor: 'alice' | 'bob', query = '') => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/knowledge-base/latest${query}`,
      headers: { 'x-kb-latest-actor': actor },
    })
    assert.equal(response.statusCode, 200, response.body)
    return response.json() as {
      data: KnowledgeVirtualRow[]
      meta: { hasMore: boolean; nextCursor: string | null }
    }
  }

  const bobsLatest = await latestAs('bob')
  const bobsIds = bobsLatest.data.map((row) => row.id)
  // The rule that matters: Bob never learns that Alice's note exists.
  assert.equal(bobsIds.includes(secret.id), false, 'a private space leaked into Latest')
  assert.ok(bobsIds.includes(runbook.id))
  assert.ok(bobsIds.includes(nested.id))
  // Folders are containers, not changes.
  assert.equal(bobsIds.includes(folder.id), false, 'a folder appeared in Latest')

  const alicesIds = (await latestAs('alice')).data.map((row) => row.id)
  assert.ok(alicesIds.includes(secret.id), 'the owner must see her own page')

  const nestedRow = bobsLatest.data.find((row) => row.id === nested.id)
  assert.ok(nestedRow)
  assert.equal(nestedRow.home.spaceId, teamSpace.id)
  assert.equal(nestedRow.home.rootKind, 'shared')
  assert.deepEqual(nestedRow.home.parentPath, [{ id: folder.id, title: 'Archive' }])
  assert.equal(nestedRow.kind, 'document')
  // A document's size is its body's, as a decimal string.
  assert.equal(nestedRow.sizeBytes, String('<p>Older note</p>'.length))
  assert.equal(nestedRow.mime, null)
  assert.deepEqual(nestedRow.indexing, { state: 'not_indexed', reason: 'draft' })

  // Keyset paging: one row at a time walks the same order without repeating.
  const firstPage = await latestAs('bob', '?limit=1')
  assert.equal(firstPage.data.length, 1)
  assert.equal(firstPage.meta.hasMore, true)
  assert.ok(firstPage.meta.nextCursor)
  const secondPage = await latestAs(
    'bob',
    `?limit=1&cursor=${encodeURIComponent(firstPage.meta.nextCursor)}`,
  )
  assert.equal(secondPage.data.length, 1)
  assert.notEqual(secondPage.data[0]?.id, firstPage.data[0]?.id)
})

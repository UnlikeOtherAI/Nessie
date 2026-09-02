import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { createNativeKnowledgeProvider } from '../src/native-provider.js'
import { KnowledgePageRevisionConflictError } from '../src/types.js'

// Optimistic concurrency for the auto-saving page editor
// (docs/navigation.md → "Drafts"). `versionNumber` belongs to a per-version
// row, so the page row carries its own `revision`, incremented on every update
// and named by the caller's `If-Match`.
const dbTest = process.env.DATABASE_URL ? test : test.skip

dbTest('a knowledge page revision advances per update and refuses a stale save', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const email = `kb-revision-${suffix}@test.local`
  let organizationId: string | null = null
  t.after(async () => {
    if (organizationId) {
      await prisma.organization.deleteMany({ where: { id: organizationId } })
    }
    await prisma.user.deleteMany({ where: { email } })
    await prisma.$disconnect()
  })

  const organization = await prisma.organization.create({
    data: { name: `kb-revision-${suffix}` },
  })
  organizationId = organization.id
  const user = await prisma.user.create({
    data: { displayName: 'Page author', email },
  })
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, userId: user.id },
  })
  const project = await prisma.project.create({
    data: { name: `kb-revision-project-${suffix}`, organizationId: organization.id },
  })
  const space = await prisma.knowledgeSpace.create({
    data: {
      createdBy: user.id,
      name: `kb-revision-space-${suffix}`,
      organizationId: organization.id,
      projectId: project.id,
      visibility: 'project',
    },
  })

  const provider = createNativeKnowledgeProvider(prisma)
  const created = await provider.createPage({
    authorId: user.id,
    authorType: 'user',
    body: 'first',
    createdBy: user.id,
    organizationId: organization.id,
    projectId: project.id,
    spaceId: space.id,
    title: 'Runbook',
  })
  // A fresh page starts at 0: nothing has been saved over it yet.
  assert.equal(created.revision, 0)

  const first = await provider.updatePage(created.id, {
    authorId: user.id,
    authorType: 'user',
    body: 'second',
    expectedRevision: 0,
    organizationId: organization.id,
  })
  assert.equal(first?.revision, 1)

  // The stale editor still holds revision 0 and is refused; the refusal names
  // the current revision so the client can offer "take theirs" in place.
  await assert.rejects(
    provider.updatePage(created.id, {
      authorId: user.id,
      authorType: 'user',
      body: 'third, from a stale tab',
      expectedRevision: 0,
      organizationId: organization.id,
    }),
    (error: unknown) => {
      assert.ok(error instanceof KnowledgePageRevisionConflictError)
      assert.equal(error.currentRevision, 1)
      return true
    },
  )

  const stored = await prisma.knowledgePage.findUnique({
    where: { id: created.id },
    select: { revision: true },
  })
  assert.equal(stored?.revision, 1, 'the refused save must have written nothing')

  // No `If-Match` is an explicit unconditional save — the "keep mine" answer.
  const overwritten = await provider.updatePage(created.id, {
    authorId: user.id,
    authorType: 'user',
    body: 'kept mine',
    organizationId: organization.id,
  })
  assert.equal(overwritten?.revision, 2)
})

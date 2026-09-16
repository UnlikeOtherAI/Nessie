import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import Fastify from 'fastify'
import { Prisma, PrismaClient } from '@prisma/client'
import { createNativeKnowledgeProvider, knowledgeExtractJobKey } from '@nessie/knowledge'
import { KNOWLEDGE_EXTRACT_TOPIC } from '@nessie/schemas'
import type { AuthorizedActionContext, KnowledgeIndexingState } from '@nessie/schemas'

import { registerKnowledgeFinderRoutes } from '../src/routes/knowledge-finder.js'
import { seedDefaultPolicies } from '../src/services/policy-seed.js'

/**
 * "Retry indexing" exists for exactly one state — a queue job that exhausted its
 * attempts — and must refuse the states where running the job again would change
 * nothing, because the row never offers the button there and only a stale panel
 * can reach it.
 *
 * Contract: docs/plans/2026-09-16-documents-finder-ui/data-and-api.md §6.
 */
const dbTest = process.env.DATABASE_URL ? test : test.skip

dbTest('reindex retries an exhausted job and refuses what it cannot help', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const email = `kb-reindex-${suffix}@test.local`
  let organizationId: string | null = null
  t.after(async () => {
    if (organizationId) {
      await prisma.$executeRaw(Prisma.sql`
        DELETE FROM queue_jobs WHERE idempotency_key LIKE ${`kb-extract:%`}
          AND payload->>'organizationId' = ${organizationId}
      `)
      await prisma.organization.deleteMany({ where: { id: organizationId } })
    }
    await prisma.user.deleteMany({ where: { email } })
    await prisma.$disconnect()
  })

  const organization = await prisma.organization.create({ data: { name: `kb-reindex-${suffix}` } })
  organizationId = organization.id
  const user = await prisma.user.create({ data: { email, displayName: 'Alice' } })
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, userId: user.id, role: 'owner' },
  })
  const project = await prisma.project.create({
    data: { name: `kb-reindex-project-${suffix}`, organizationId: organization.id },
  })
  await prisma.projectMember.create({
    data: { projectId: project.id, userId: user.id, role: 'owner' },
  })
  await seedDefaultPolicies(prisma, organization.id, user.id)
  const team = await prisma.team.create({
    data: { name: `kb-reindex-team-${suffix}`, projectId: project.id },
  })
  const space = await prisma.knowledgeSpace.create({
    data: {
      createdBy: user.id,
      name: 'Team folder',
      organizationId: organization.id,
      projectId: project.id,
      teamId: team.id,
      visibility: 'project',
    },
  })

  const provider = createNativeKnowledgeProvider(prisma)
  const scope = {
    authorId: user.id,
    authorType: 'user' as const,
    createdBy: user.id,
    organizationId: organization.id,
    projectId: project.id,
    teamId: team.id,
    spaceId: space.id,
  }
  const blob = async (filename: string, mime: string) => prisma.attachment.create({
    data: {
      organizationId: organization.id,
      uploaderId: user.id,
      kind: 'file',
      mime,
      filename,
      sizeBytes: 64n,
      storageKey: `test/${randomUUID()}`,
    },
  })

  const folder = await provider.createPage({ ...scope, kind: 'folder', title: 'Contracts' })
  const image = await provider.createPage({
    ...scope,
    kind: 'file',
    attachmentId: (await blob('logo.png', 'image/png')).id,
    title: 'logo.png',
  })
  const notes = await provider.createPage({
    ...scope,
    kind: 'file',
    attachmentId: (await blob('notes.txt', 'text/plain')).id,
    title: 'notes.txt',
  })
  const notesVersionId = notes.latestVersion?.id ?? ''
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO queue_jobs (topic, payload, status, idempotency_key, attempt, max_attempts)
    VALUES (
      ${KNOWLEDGE_EXTRACT_TOPIC},
      ${JSON.stringify({ organizationId: organization.id })}::jsonb,
      'dead',
      ${knowledgeExtractJobKey(notes.id, notesVersionId)},
      3,
      3
    )
  `)

  const app = Fastify({ logger: false })
  const actorContext = {
    actionContext: {
      requestId: `kb-reindex-${suffix}`,
      effectiveUserId: user.id,
      agentId: randomUUID(),
      teamId: team.id,
    },
    actor: { actorId: user.id, actorType: 'user', roles: ['owner'] },
    tenant: { organizationId: organization.id, projectId: project.id, teamId: team.id },
  } as unknown as AuthorizedActionContext
  registerKnowledgeFinderRoutes(app, {
    prisma,
    knowledgeProvider: provider,
    fileService: { usageForScope: async () => 0n },
    isProjectAccessibleToActor: async () => true,
    requireActorContext: () => actorContext,
  } as unknown as Parameters<typeof registerKnowledgeFinderRoutes>[1])

  const reindex = (pageId: string) => app.inject({
    method: 'POST',
    url: `/api/knowledge-base/pages/${pageId}/reindex`,
  })

  // A folder has nothing to index, and an image never will be searchable.
  for (const page of [folder, image]) {
    const refused = await reindex(page.id)
    assert.equal(refused.statusCode, 400, refused.body)
    assert.equal(
      (refused.json() as { error: { code: string } }).error.code,
      'REINDEX_NOT_APPLICABLE',
    )
  }

  const retried = await reindex(notes.id)
  assert.equal(retried.statusCode, 202, retried.body)
  const state = (retried.json() as { data: { indexing: KnowledgeIndexingState } }).data.indexing
  assert.deepEqual(state, { state: 'pending', stage: 'extract' })

  // The exhausted row keeps its key — the unique index would swallow a reuse —
  // so the retry lands under a suffixed one and the status read finds it by the
  // shared prefix.
  const jobs = await prisma.$queryRaw<Array<{ idempotencyKey: string; status: string }>>(Prisma.sql`
    SELECT idempotency_key AS "idempotencyKey", status
    FROM queue_jobs
    WHERE idempotency_key LIKE ${`${knowledgeExtractJobKey(notes.id, notesVersionId)}%`}
    ORDER BY enqueued_at ASC
  `)
  assert.equal(jobs.length, 2)
  assert.equal(jobs[1]?.idempotencyKey.endsWith(':retry:4'), true, jobs[1]?.idempotencyKey)
  assert.equal(jobs[1]?.status, 'pending')
})

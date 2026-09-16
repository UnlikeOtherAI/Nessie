import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { Prisma, PrismaClient } from '@prisma/client'
import { KNOWLEDGE_EXTRACT_MAX_ATTACHMENT_BYTES, KNOWLEDGE_EXTRACT_TOPIC } from '@nessie/schemas'

import { createNativeKnowledgeProvider } from '../src/native-provider.js'
import {
  indexingStatesFor,
  knowledgeExtractJobKey,
} from '../src/native-indexing-status.js'

/**
 * The indexing state is derived, never stored, so a stub proves nothing: the
 * chunks, the embeddings and the queue row are the inputs, and they only exist
 * in Postgres. Every case here is one row of
 * docs/plans/2026-09-16-documents-finder-ui/uploads-and-indexing.md §4.
 */
const dbTest = process.env.DATABASE_URL ? test : test.skip

const zeroVector = `[${Array.from({ length: 1024 }, () => 0).join(',')}]`

dbTest('indexing status tells the truth about every kind of row', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const email = `kb-indexing-${suffix}@test.local`
  let organizationId: string | null = null
  t.after(async () => {
    if (organizationId) {
      await prisma.$executeRaw(Prisma.sql`
        DELETE FROM queue_jobs WHERE idempotency_key LIKE ${`kb-%${suffix}%`}
      `)
      await prisma.organization.deleteMany({ where: { id: organizationId } })
    }
    await prisma.user.deleteMany({ where: { email } })
    await prisma.$disconnect()
  })

  const organization = await prisma.organization.create({ data: { name: `kb-indexing-${suffix}` } })
  organizationId = organization.id
  const user = await prisma.user.create({ data: { displayName: 'Indexer', email } })
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, userId: user.id },
  })
  const project = await prisma.project.create({
    data: { name: `kb-indexing-project-${suffix}`, organizationId: organization.id },
  })
  const space = await prisma.knowledgeSpace.create({
    data: {
      createdBy: user.id,
      name: `kb-indexing-space-${suffix}`,
      organizationId: organization.id,
      projectId: project.id,
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
    spaceId: space.id,
  }
  const attachment = async (filename: string, mime: string, sizeBytes: bigint) =>
    prisma.attachment.create({
      data: {
        organizationId: organization.id,
        uploaderId: user.id,
        kind: 'file',
        mime,
        filename,
        sizeBytes,
        storageKey: `test/${randomUUID()}`,
      },
    })

  const folder = await provider.createPage({ ...scope, kind: 'folder', title: 'Contracts' })
  const draft = await provider.createPage({ ...scope, body: '<p>Not yet</p>', title: 'Draft note' })
  const draftPublished = await provider.createPage({ ...scope, body: '<p>Published body</p>', title: 'Runbook' })
  const published = await provider.publishPage({
    organizationId: organization.id,
    pageId: draftPublished.id,
  })
  assert.ok(published, 'the page under test must publish')
  const draftEmpty = await provider.createPage({ ...scope, body: '', title: 'Nothing in it' })
  const emptyPublished = await provider.publishPage({
    organizationId: organization.id,
    pageId: draftEmpty.id,
  })
  assert.ok(emptyPublished, 'the empty page under test must publish')

  const image = await attachment('diagram.png', 'image/png', 4096n)
  const imageFile = await provider.createPage({
    ...scope,
    kind: 'file',
    attachmentId: image.id,
    title: 'diagram.png',
  })
  const huge = await attachment(
    'giant.txt',
    'text/plain',
    BigInt(KNOWLEDGE_EXTRACT_MAX_ATTACHMENT_BYTES) + 1n,
  )
  const hugeFile = await provider.createPage({
    ...scope,
    kind: 'file',
    attachmentId: huge.id,
    title: 'giant.txt',
  })
  const notes = await attachment('notes.txt', 'text/plain', 120n)
  const queuedFile = await provider.createPage({
    ...scope,
    kind: 'file',
    attachmentId: notes.id,
    title: 'notes.txt',
  })
  const exhausted = await attachment('broken.txt', 'text/plain', 120n)
  const deadFile = await provider.createPage({
    ...scope,
    kind: 'file',
    attachmentId: exhausted.id,
    title: 'broken.txt',
  })

  const enqueue = async (pageId: string, versionId: string, status: string) => {
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO queue_jobs (topic, payload, status, idempotency_key, attempt, max_attempts)
      VALUES (
        ${KNOWLEDGE_EXTRACT_TOPIC},
        ${'{}'}::jsonb,
        ${status},
        ${`${knowledgeExtractJobKey(pageId, versionId)}:${suffix}`},
        ${status === 'dead' ? 3 : 0},
        3
      )
    `)
  }
  // The key the status read matches on is the (page, version) prefix, so a
  // suffixed test key is found exactly as a real retry would be.
  await enqueue(queuedFile.id, queuedFile.latestVersion?.id ?? '', 'processing')
  await enqueue(deadFile.id, deadFile.latestVersion?.id ?? '', 'dead')

  const states = await indexingStatesFor(prisma, [
    folder, draft, published, emptyPublished, imageFile, hugeFile, queuedFile, deadFile,
  ].map((page) => ({
    id: page.id,
    kind: page.kind,
    status: page.status,
    publishedVersionId: page.publishedVersionId,
  })))

  assert.deepEqual(states.get(folder.id), { state: 'not_applicable' })
  assert.deepEqual(states.get(draft.id), { state: 'not_indexed', reason: 'draft' })
  // A published document with nothing in it is not "indexing forever": there
  // was no text to chunk, and the row says so.
  assert.deepEqual(states.get(emptyPublished.id), { state: 'not_indexed', reason: 'empty' })
  assert.deepEqual(states.get(imageFile.id), { state: 'not_indexed', reason: 'unsupported' })
  assert.deepEqual(states.get(hugeFile.id), { state: 'not_indexed', reason: 'too_large' })
  assert.deepEqual(states.get(queuedFile.id), { state: 'pending', stage: 'extract' })
  assert.deepEqual(states.get(deadFile.id), { state: 'failed', stage: 'extract' })
  // Publishing chunks the version; the embeddings are a separate job, so the
  // honest state between the two is "preparing search".
  assert.deepEqual(states.get(published.id), { state: 'pending', stage: 'embed' })

  const publishedVersionId = published.publishedVersionId
    ?? published.latestVersion?.id
    ?? ''
  await prisma.$executeRaw(Prisma.sql`
    UPDATE knowledge_page_chunks
       SET embedding = ${zeroVector}::vector, embedding_model = 'test-model', dims = 1024
     WHERE page_id = ${published.id}::uuid
  `)
  const embedded = await indexingStatesFor(prisma, [{
    id: published.id,
    kind: published.kind,
    status: 'published',
    publishedVersionId: published.publishedVersionId,
  }])
  assert.deepEqual(embedded.get(published.id), { state: 'indexed', versionId: publishedVersionId })
})

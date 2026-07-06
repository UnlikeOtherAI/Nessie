import assert from 'node:assert/strict'
import test from 'node:test'

import type { Prisma } from '@prisma/client'
import { replaceKnowledgePageVersionChunks, type ChunkablePage } from '../src/native-chunks.js'

const basePage: ChunkablePage = {
  id: 'page-1',
  organizationId: 'org-1',
  projectId: 'project-1',
  teamId: null,
  channelId: null,
  threadId: null,
  userId: null,
  visibility: 'project',
  sensitivityTier: 'normal',
  privateToAgentId: null,
  taskId: null,
}

const body =
  '<p>Storage quota is enforced before uploads and every blob operation goes through FileService.</p>'

test('replaceKnowledgePageVersionChunks writes the page taskId onto every chunk row', async () => {
  let capturedSql: string | undefined
  let capturedValues: readonly unknown[] | undefined
  const tx = {
    $queryRaw: async () => [],
    $executeRaw: async (query: { sql: string; values: readonly unknown[] }) => {
      capturedSql = query.sql
      capturedValues = query.values
      return 1
    },
  } as unknown as Prisma.TransactionClient

  const written = await replaceKnowledgePageVersionChunks(tx, {
    page: { ...basePage, taskId: 'task-1' },
    version: { id: 'version-1', body },
  })

  assert.equal(written, true)
  assert.match(capturedSql ?? '', /task_id/)
  assert.ok(capturedValues?.includes('task-1'), 'expected the chunk insert to carry the page taskId')
})

test('replaceKnowledgePageVersionChunks writes a null task_id for untagged pages', async () => {
  let capturedValues: readonly unknown[] | undefined
  const tx = {
    $queryRaw: async () => [],
    $executeRaw: async (query: { values: readonly unknown[] }) => {
      capturedValues = query.values
      return 1
    },
  } as unknown as Prisma.TransactionClient

  await replaceKnowledgePageVersionChunks(tx, {
    page: basePage,
    version: { id: 'version-2', body },
  })

  assert.ok(capturedValues?.includes(null), 'expected the chunk insert to carry a null taskId')
})

test('replaceKnowledgePageVersionChunks is a no-op when the version is already chunked', async () => {
  let executeCalled = false
  const tx = {
    $queryRaw: async () => [{ present: 1 }],
    $executeRaw: async () => {
      executeCalled = true
      return 0
    },
  } as unknown as Prisma.TransactionClient

  const written = await replaceKnowledgePageVersionChunks(tx, {
    page: { ...basePage, taskId: 'task-1' },
    version: { id: 'version-1', body },
  })

  assert.equal(written, false)
  assert.equal(executeCalled, false)
})

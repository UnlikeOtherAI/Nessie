import assert from 'node:assert/strict'
import test from 'node:test'
import type { Readable } from 'node:stream'

import type { FileService } from '@nessie/runtime'

import {
  KnowledgeFileRowError,
  storeFileWithRollback,
  type StoreFileWithRollbackInput,
} from '../src/services/knowledge-file-store.js'

// F1-8: this is the compensating-transaction workflow `knowledge-base-files.ts`
// used to hand-roll twice (once for `POST .../files`, once for
// `POST .../file-version`). No Fastify/multipart harness needed — the whole
// contract is store → createRow → roll back on truncation or failure.

const fakeBody = (truncated: boolean): Readable & { truncated: boolean } =>
  ({ truncated }) as unknown as Readable & { truncated: boolean }

const fakeStoreInput = (body: Readable & { truncated: boolean }): StoreFileWithRollbackInput =>
  ({
    attribution: { source: 'system' },
    organizationId: 'org-1',
    uploaderId: 'user-1',
    filename: 'a.txt',
    mime: 'text/plain',
    body,
  }) as unknown as StoreFileWithRollbackInput

test('a truncated upload is deleted and never reaches createRow', async () => {
  const deletedIds: string[] = []
  const createRowCalls: string[] = []
  const fileService = {
    store: async () => ({ attachment: { id: 'att-1' }, bytesWritten: 10 }),
    delete: async (id: string) => {
      deletedIds.push(id)
      return true
    },
  } as unknown as FileService

  const outcome = await storeFileWithRollback(
    fileService,
    fakeStoreInput(fakeBody(true)),
    async (attachmentId) => {
      createRowCalls.push(attachmentId)
      return { ok: true }
    },
  )

  assert.deepEqual(outcome, { kind: 'truncated' })
  assert.deepEqual(deletedIds, ['att-1'])
  assert.deepEqual(createRowCalls, [], 'createRow must not run for a truncated upload')
})

test('a createRow failure deletes the blob and wraps the original error as its cause', async () => {
  const deletedIds: string[] = []
  const fileService = {
    store: async () => ({ attachment: { id: 'att-2' }, bytesWritten: 10 }),
    delete: async (id: string) => {
      deletedIds.push(id)
      return true
    },
  } as unknown as FileService
  const cause = new Error('row rejected')

  await assert.rejects(
    () => storeFileWithRollback(fileService, fakeStoreInput(fakeBody(false)), async () => {
      throw cause
    }),
    (error: unknown) => {
      assert.ok(error instanceof KnowledgeFileRowError)
      assert.equal(error.cause, cause)
      return true
    },
  )
  assert.deepEqual(deletedIds, ['att-2'])
})

test('a delete failure after a createRow failure is swallowed, not masking the original error', async () => {
  const fileService = {
    store: async () => ({ attachment: { id: 'att-3' }, bytesWritten: 10 }),
    delete: async () => {
      throw new Error('storage backend unreachable')
    },
  } as unknown as FileService
  const cause = new Error('row rejected')

  await assert.rejects(
    () => storeFileWithRollback(fileService, fakeStoreInput(fakeBody(false)), async () => {
      throw cause
    }),
    (error: unknown) => {
      assert.ok(error instanceof KnowledgeFileRowError)
      assert.equal(error.cause, cause, 'the original row-creation error must survive the delete failure')
      return true
    },
  )
})

test('a successful createRow keeps the blob and returns its row', async () => {
  const deletedIds: string[] = []
  const fileService = {
    store: async () => ({ attachment: { id: 'att-4' }, bytesWritten: 10 }),
    delete: async (id: string) => {
      deletedIds.push(id)
      return true
    },
  } as unknown as FileService

  const outcome = await storeFileWithRollback(
    fileService,
    fakeStoreInput(fakeBody(false)),
    async (attachmentId) => ({ id: 'page-1', attachmentId }),
  )

  assert.deepEqual(outcome, {
    kind: 'created',
    attachmentId: 'att-4',
    row: { id: 'page-1', attachmentId: 'att-4' },
  })
  assert.deepEqual(deletedIds, [], 'a successful row must not roll back its own blob')
})

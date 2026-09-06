import type { Readable } from 'node:stream'

import type { FileService, StoreFileInput } from '@nessie/runtime'

/**
 * The store-then-create-with-rollback workflow both knowledge-base file
 * uploads need: stash the blob, hand its attachment id to whatever row
 * references it, and undo the storage write if that row never lands.
 *
 * A blob outliving the row that was supposed to point at it is exactly the
 * orphaned-attachment leak this exists to close — `POST .../files` and
 * `POST .../file-version` used to hand-roll it, in step with each other by
 * coincidence rather than by sharing code.
 */

/**
 * Wraps a `createRow` failure so a caller with one `try`/`catch` around a
 * single `storeFileWithRollback` call can still tell a row-creation fault
 * (validation, conflict — mapped with the knowledge-mutation error helper)
 * apart from a storage fault (quota, size — mapped with the file-service
 * error helper), the same distinction the two former call sites made by
 * having two separate `try` blocks. The original error survives as `cause`.
 */
export class KnowledgeFileRowError extends Error {
  constructor(readonly cause: unknown) {
    super('Knowledge file row could not be created')
    this.name = 'KnowledgeFileRowError'
  }
}

export type StoreFileWithRollbackInput = Omit<StoreFileInput, 'body'> & {
  /** The multipart stream, whose `truncated` flag `store()` populates as it reads. */
  body: Readable & { truncated: boolean }
}

export type StoreFileWithRollbackOutcome<T> =
  | { kind: 'truncated' }
  | { kind: 'created'; attachmentId: string; row: T }

/**
 * Stores a blob, then runs `createRow` with its attachment id.
 *
 * A truncated upload is deleted and reported before `createRow` ever runs —
 * there is no row to create for bytes that were rejected mid-stream. A
 * `createRow` failure deletes the same blob (delete failures are swallowed,
 * matching the callers this replaced: an orphan is a lesser problem than
 * masking the original error) and rethrows as `KnowledgeFileRowError`.
 *
 * `fileService.store()` itself is left uncaught: its errors (quota, size)
 * are a distinct fault class the caller maps with `sendFileServiceError`,
 * and nothing has been created yet for this function to roll back.
 */
export const storeFileWithRollback = async <T>(
  fileService: FileService,
  storeInput: StoreFileWithRollbackInput,
  createRow: (attachmentId: string) => Promise<T>,
): Promise<StoreFileWithRollbackOutcome<T>> => {
  const stored = await fileService.store(storeInput)
  const attachmentId = stored.attachment.id

  if (storeInput.body.truncated) {
    await fileService.delete(attachmentId, storeInput.organizationId, storeInput.attribution)
    return { kind: 'truncated' }
  }

  try {
    const row = await createRow(attachmentId)
    return { kind: 'created', attachmentId, row }
  } catch (error) {
    await fileService
      .delete(attachmentId, storeInput.organizationId, storeInput.attribution)
      .catch(() => undefined)
    throw new KnowledgeFileRowError(error)
  }
}

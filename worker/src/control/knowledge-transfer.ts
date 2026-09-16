import type { PrismaClient } from '@prisma/client'
import type { FileService } from '@nessie/runtime'
import type { KnowledgeTransferJobPayload } from '@nessie/schemas'

/**
 * `knowledge.transfer` worker handler — a cross-space move or copy of more
 * than `TRANSFER_SYNCHRONOUS_MAX_PAGES` pages.
 *
 * Subscribed and inert in Wave 0: the topic, the payload shape and this
 * symbol are fixed now so the route that enqueues (Wave 1E) and the
 * subscription that consumes are written against one contract. Wave 1E fills
 * the body. A job that arrives before then is a no-op rather than a crash —
 * nothing enqueues this topic yet, and a handler that threw would turn an
 * impossible job into a red queue.
 *
 * What the body must do (transfer.md §5):
 *
 * - take the same two tree locks the synchronous path takes, lower space id
 *   first, so two concurrent transfers cannot deadlock or interleave;
 * - re-run the refusals, because the world may have changed since the request;
 * - process the subtree in batches of 200 pages, each batch its own
 *   transaction in parent-before-child order, writing `done`/`total` into the
 *   job's `payload.progress` after each batch;
 * - on failure mark the job failed, clear `metadata.transfer`, and for a
 *   **copy** delete everything the earlier batches created (the id map is in
 *   the payload) so a partial copy never lingers. For a **move** the committed
 *   batches stand: each rewrote its pages *and* their chunks, so they are
 *   internally consistent, and the rest stayed where they were.
 */
export const executeKnowledgeTransferJob = async (
  _deps: { fileService: FileService; prisma: PrismaClient },
  _payload: KnowledgeTransferJobPayload,
): Promise<void> => {
  // Wave 1E.
}

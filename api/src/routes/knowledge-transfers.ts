import type { FastifyInstance } from 'fastify'

import type { KnowledgeRouteDeps } from './knowledge-base-access.js'

/**
 * Moving and copying pages between root folders (spaces).
 *
 * This is new API surface, not a widened `movePage`: the provider's move
 * requires the new parent to be in the page's own space and never changes
 * `spaceId`.
 *
 * The load-bearing fact for whoever fills this in: a move rewrites the pages
 * **and every chunk's scope mirror** in one transaction. Retrieval reads the
 * chunk row alone, so a chunk left on the old scope would keep answering the
 * old audience — a moved document would still be findable by people who can no
 * longer open it. The annotations' denormalised `spaceId` and the storage
 * ledger move in the same transaction for the same reason.
 *
 * Up to `TRANSFER_SYNCHRONOUS_MAX_PAGES` the whole thing is one request; above
 * it the route stamps the roots, enqueues `knowledge.transfer` and answers 202.
 *
 * Registered and empty in Wave 0; Wave 1E fills the handlers.
 *
 * Contract: docs/plans/2026-09-16-documents-finder-ui/transfer.md §2–5.
 *
 *   POST /api/knowledge-base/transfers
 *   GET  /api/knowledge-base/transfers/:transferId
 */
export const registerKnowledgeTransferRoutes = (
  _app: FastifyInstance,
  _deps: KnowledgeRouteDeps,
): void => {
  // Wave 1E.
}

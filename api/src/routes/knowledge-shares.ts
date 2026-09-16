import type { FastifyInstance } from 'fastify'

import type { KnowledgeRouteDeps } from './knowledge-base-access.js'

/**
 * Person-to-person sharing of a page the sharer owns.
 *
 * Registered and empty in Wave 0; Wave 1B fills the handlers and Wave 2A adds
 * the `knowledge_shared` alert write (one deploy after the reader side, which
 * Wave 0 shipped).
 *
 * Two rules the handlers must keep, recorded here because they are what the
 * routes exist to enforce rather than details of any one of them:
 *
 * 1. **No approval gate.** The agent publication approval
 *    (`knowledge.page.publish`) exists because agents draft and a person
 *    publishes. A person sharing their own document with another person is a
 *    different act: the row is written on the request and takes effect on the
 *    next read. It must never create an `Approval` row.
 * 2. **Only the sharer reads the list.** A grantee asking who else a page is
 *    shared with gets the same 403 as a stranger, so the list never discloses
 *    the other recipients.
 *
 * Contract: docs/plans/2026-09-16-documents-finder-ui/data-and-api.md §2.
 *
 *   GET    /api/knowledge-base/pages/:pageId/shares
 *   POST   /api/knowledge-base/pages/:pageId/shares
 *   PATCH  /api/knowledge-base/pages/:pageId/shares/:granteeUserId
 *   DELETE /api/knowledge-base/pages/:pageId/shares/:granteeUserId
 */
export const registerKnowledgeShareRoutes = (
  _app: FastifyInstance,
  _deps: KnowledgeRouteDeps,
): void => {
  // Wave 1B.
}

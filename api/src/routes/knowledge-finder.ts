import type { FastifyInstance } from 'fastify'

import type { KnowledgeRouteDeps } from './knowledge-base-access.js'

/**
 * The Finder's own reads: the root column, Latest, Get Info for a page and for
 * a space, reindex, and provisioning a project's Documents space on first open.
 *
 * Registered and empty in Wave 0. The registration exists now so the wiring,
 * the file name and the exported symbol are fixed before five agents build
 * against them in parallel; Wave 1A fills the handlers. An empty registrar is
 * deliberately not a `404` handler — Fastify already answers 404 for a path
 * nothing claimed, and a handler that answered anything would be a route that
 * exists without doing what its contract says.
 *
 * New routes land here rather than in `knowledge-base.ts` (666 lines) or
 * `knowledge-base-files.ts` (619), both already past the 500-line cap.
 *
 * Contract: docs/plans/2026-09-16-documents-finder-ui/data-and-api.md §3, §5–7.
 *
 *   GET  /api/knowledge-base/root
 *   GET  /api/knowledge-base/latest
 *   GET  /api/knowledge-base/pages/:pageId/info
 *   GET  /api/knowledge-base/spaces/:spaceId/info
 *   POST /api/knowledge-base/pages/:pageId/reindex
 *   POST /api/knowledge-base/projects/:projectId/documents
 */
export const registerKnowledgeFinderRoutes = (
  _app: FastifyInstance,
  _deps: KnowledgeRouteDeps,
): void => {
  // Wave 1A.
}

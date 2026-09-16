import type { FastifyInstance } from 'fastify'

import type { KnowledgeRouteDeps } from './knowledge-base-access.js'

/**
 * The Shared with me virtual folder: pages other people shared with the
 * viewer, newest share first.
 *
 * Deliberately *not* spaces somebody added the viewer to — those are already
 * folders in the root's shared group, and listing them here too would show the
 * same thing twice under two different names.
 *
 * A shared folder is one row; opening it lists its children through
 * `GET /spaces/:spaceId/pages?sharedRootPageId=<folderId>`, which the grantee
 * may call although the space is private to the sharer. Without the param the
 * 403 stands.
 *
 * Registered and empty in Wave 0; Wave 1B fills the handler.
 *
 * Contract: docs/plans/2026-09-16-documents-finder-ui/data-and-api.md §4.
 *
 *   GET /api/knowledge-base/shared-with-me
 */
export const registerKnowledgeSharedWithMeRoutes = (
  _app: FastifyInstance,
  _deps: KnowledgeRouteDeps,
): void => {
  // Wave 1B.
}

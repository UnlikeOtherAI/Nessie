import type { Prisma } from '@prisma/client'
import type { DisclosureViewer } from '@nessie/runtime'

/**
 * Conservative query-time companion to `canReadKnowledgePageVersion`.
 *
 * Page cards expose title and summary before a caller can choose an individual
 * version, so every retained version must be readable here. This intentionally
 * hides a page with an unreadable historical version until annotations and
 * metadata are version-bound; it keeps cursors and counts from advertising a
 * row the post-read gate would remove.
 */
export const readableKnowledgePageVersionsWhere = (
  viewer: DisclosureViewer | undefined,
): Prisma.KnowledgePageWhereInput => {
  if (!viewer) return {}
  if (viewer.kind === 'denied') return { id: { in: [] } }
  if (viewer.kind === 'autonomous') {
    return {
      versions: {
        none: {
          OR: [
            { basisScopes: { some: {} } },
            { disclosureSources: { some: { sourceAuthorUserId: null } } },
          ],
        },
      },
    }
  }
  const reachable = viewer.scopes.map((scope) => ({
    scopeId: scope.scopeId,
    scopeType: scope.scopeType,
  }))
  return {
    versions: {
      none: {
        OR: [
          { disclosureSources: { some: { sourceAuthorUserId: null } } },
          { basisScopes: { some: { NOT: { OR: reachable } } } },
        ],
      },
    },
  }
}

import {
  viewerSatisfiesBasis,
  type DisclosureViewer,
} from '@nessie/runtime'
import type { KnowledgePageVersionRecord } from './types.js'

/**
 * The version-level half of document access. Callers must first establish the
 * ordinary space/home entitlement; a source-derived version then requires every
 * narrower basis scope. A recorded unknown private author is deliberately
 * unreadable until a later exact-content authorization path can prove it.
 */
export const canReadKnowledgePageVersion = (
  version: Pick<KnowledgePageVersionRecord, 'basisScopes' | 'disclosureSources'>,
  viewer: DisclosureViewer,
): boolean =>
  !version.disclosureSources.some((source) => source.sourceAuthorUserId === null)
  && viewerSatisfiesBasis(version.basisScopes, viewer)

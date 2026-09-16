import type { PrismaClient } from '@prisma/client'
import {
  canReadKnowledgePageVersion,
  canReadSpace,
  loadSpaceViewer,
  mapSpace,
  mapVersion,
  spaceInclude,
  versionInclude,
  viewerHoldsPageShare,
} from '@nessie/knowledge'
import { resolveDisclosureViewer, resolveLiveEntitlements } from '@nessie/runtime'

/**
 * "May this person still read this page?", for the document lane.
 *
 * It is the same two-part question the page routes ask — may this person reach
 * the page (through the space, **or** through a person-to-person share on it or
 * on a folder above it) **and** is every retained version readable — and it has
 * to be both.
 *
 * The share arm is not decoration. `accessPageSpace` lets a grantee open the
 * lane, and this gate re-runs every 5 s per connection: without the same arm a
 * `view` share connected, stayed open and delivered nothing at all, which is
 * the failure mode the paragraph below was written after. With it, the two
 * answers agree, and a revoked share stops delivery within one window rather
 * than at the next reconnect — a hard delete is how revocation is recorded, so
 * the very next walk finds nothing. A spreadsheet's live lane carries the workbook's changes,
 * and a version's disclosure basis is exactly the boundary that stops an
 * agent's private-conversation material reaching somebody the conversation was
 * never shared with. Asking only the space question here would have made the
 * lane the one door in the knowledge surface that skipped it.
 *
 * Lives beside the hub rather than in `delivery-entitlements.ts` because it
 * needs `@nessie/knowledge`, which that module (the shared entitlement
 * vocabulary for every lane) deliberately does not depend on. The lane
 * memoises the answer for 5 s per connection, so this runs at most once per
 * connection per window, never once per event.
 */
export const canReadSpaceForDocumentLane = async (
  prisma: PrismaClient,
  input: { pageId: string; organizationId: string; userId: string },
): Promise<boolean> => {
  const page = await prisma.knowledgePage.findFirst({
    where: { id: input.pageId, organizationId: input.organizationId, deletedAt: null },
    select: { id: true, spaceId: true, status: true, deletedAt: true },
  })
  if (!page) return false

  // Through the mapper, and never a raw row cast past the type: a
  // `KnowledgeSpaceRecord` carries `memberUserIds`/`memberAgentIds` from the
  // `members` relation, and `canReadSpace` reads them for every visibility but
  // `organization` and `project`. A bare `findFirst` has neither, so the gate
  // threw a TypeError on the first event for a page in a private space —
  // inside an unawaited promise, which on Node 22 takes the replica with it.
  const spaceRow = await prisma.knowledgeSpace.findFirst({
    where: { id: page.spaceId, organizationId: input.organizationId, deletedAt: null },
    include: spaceInclude,
  })
  if (!spaceRow) return false
  const space = mapSpace(spaceRow)

  // **The live entitlement proof is not optional here.** `loadUserViewer`
  // never infers a viewer from persisted membership — without a proof it
  // returns the denied viewer, whose `baseEntitled: false` makes
  // `canReadSpace` refuse before it looks at anything. Called without one,
  // this gate denied *every* document event to *every* connection, so the
  // lane connected, stayed open, and delivered nothing at all.
  //
  // `allowStoredIdentity` is the arm this case is written for: a delivery-time
  // recheck has no request session to carry a UOA assertion, and the stored
  // link's subject and epoch still have to survive `/org/me`. On a local
  // install with no identity provider it resolves the current active
  // membership, which is the same authority the request path uses.
  const liveEntitlements = await resolveLiveEntitlements(prisma, {
    allowStoredIdentity: true,
    organizationId: input.organizationId,
    userId: input.userId,
  })
  const viewer = await loadSpaceViewer(
    prisma,
    input.organizationId,
    { actorType: 'user', actorId: input.userId },
    { liveEntitlements },
  )
  if (!canReadSpace(space, viewer)) {
    // `viewerHoldsPageShare` carries the preconditions — a person, a live
    // organization proof, and a page that is neither archived nor deleted — so
    // the owner archiving a shared page ends delivery without anybody revoking
    // a row.
    const shared = await viewerHoldsPageShare(prisma, {
      organizationId: input.organizationId,
      actorType: 'user',
      page: {
        id: page.id,
        status: page.status,
        deletedAt: page.deletedAt === null ? null : page.deletedAt.toISOString(),
      },
      viewer,
      minimum: 'view',
    })
    if (!shared) return false
  }

  const disclosureViewer = await resolveDisclosureViewer(
    prisma,
    input.organizationId,
    input.userId,
    { liveEntitlements },
  )
  if (!disclosureViewer) return true

  const versions = await prisma.knowledgePageVersion.findMany({
    where: { pageId: input.pageId },
    include: versionInclude,
  })
  return versions.every((version) => {
    const mapped = mapVersion(version)
    // A version row the mapper cannot read is not one this person has been
    // shown the basis for; refuse rather than assume.
    return mapped ? canReadKnowledgePageVersion(mapped, disclosureViewer) : false
  })
}

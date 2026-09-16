import type { PrismaClient } from '@prisma/client'
import {
  canReadKnowledgePageVersion,
  canReadSpace,
  loadSpaceViewer,
  mapVersion,
  versionInclude,
} from '@nessie/knowledge'
import { resolveDisclosureViewer } from '@nessie/runtime'

/**
 * "May this person still read this page?", for the document lane.
 *
 * It is the same two-part question the page routes ask —
 * `canReadSpace(space, viewer)` **and** every retained version readable — and
 * it has to be both. A spreadsheet's live lane carries the workbook's changes,
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
    select: { spaceId: true },
  })
  if (!page) return false

  const space = await prisma.knowledgeSpace.findFirst({
    where: { id: page.spaceId, organizationId: input.organizationId, deletedAt: null },
  })
  if (!space) return false

  const viewer = await loadSpaceViewer(prisma, input.organizationId, {
    actorType: 'user',
    actorId: input.userId,
  })
  if (!canReadSpace(space as never, viewer)) return false

  const disclosureViewer = await resolveDisclosureViewer(
    prisma,
    input.organizationId,
    input.userId,
    {},
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

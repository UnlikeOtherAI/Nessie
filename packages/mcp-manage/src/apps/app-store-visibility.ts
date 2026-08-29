import { Prisma } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { catalogTenancyWhere } from '../mcp-catalog-visibility.js'

/**
 * What the App Store is allowed to show, composed on top of the one tenancy
 * floor every catalogue read uses (`catalogTenancyWhere`) rather than restated
 * beside it. `organizationId: null` is the instance's own first-party rows,
 * readable by every tenant; nothing else crosses a tenant boundary.
 *
 * Above that floor the store reads `moderationState`, deliberately *not* the
 * connector `visibility`/`status` lifecycle: a curated listing is a store
 * decision, and several apps that belong in the store (Gmail, GitHub, Linear)
 * are seeded as private drafts because nobody has installed them yet.
 * `discovered` is a registry row nobody has looked at, `hidden` is a
 * deliberate removal, and a `blocked` trust level is a moderation outcome —
 * none of the three is something to offer a member.
 *
 * `curated` carries one extra condition, and it is a real one. The store
 * migration backfilled `curated` onto *every* pre-existing non-public entry,
 * so without it a member's private draft connector would be listed as an app
 * to everyone else in the organisation. A curated row is therefore listed only
 * where `getAccessibleCatalogEntry` would hand it over anyway — the published
 * public store, or the caller's own entries. `approved` is an explicit
 * decision a human made about the store and needs no such qualification.
 * Governance of other people's entries stays on the Connectors page.
 *
 * `catalogTenancyWhere` and the curation rule are both top-level `OR`s, so
 * they are nested under `AND`: spreading them into one object would silently
 * drop one of the two.
 */

const curatedEntryWhere = (
  actorContext: AuthorizedActionContext,
): Prisma.McpCatalogEntryWhereInput => ({
  AND: [
    { moderationState: 'curated' },
    {
      OR: [
        { visibility: 'public', status: 'published' },
        { ownerUserId: actorContext.actor.actorId },
      ],
    },
  ],
})

export const storeCatalogWhere = (
  actorContext: AuthorizedActionContext,
): Prisma.McpCatalogEntryWhereInput => ({
  trustLevel: { not: 'blocked' },
  AND: [
    catalogTenancyWhere(actorContext),
    {
      OR: [
        { moderationState: 'approved' },
        curatedEntryWhere(actorContext),
      ],
    },
  ],
})

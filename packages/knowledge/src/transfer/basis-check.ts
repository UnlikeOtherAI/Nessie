import { Prisma } from '@prisma/client'

import type { TransferSpaceScope } from './collect.js'

/**
 * The widening rule (transfer.md §4.1).
 *
 * A transfer changes who can read a page from the source space's audience to
 * the destination's. Ordinary widening — a private draft dragged into a project
 * folder — is *allowed*; the prompt says so out loud, and it is the reason
 * people move things into a project at all. What is refused is widening past a
 * version's **basis**: `KnowledgePageVersionBasisScope` rows say the material
 * an agent read to write this version came from somewhere, and a destination
 * audience that cannot reach that somewhere must not receive it
 * (docs/standards/disclosure-boundaries.md).
 *
 * The rule is deterministic and takes no viewer. *Rejected:* evaluating it with
 * the actor's own `DisclosureViewer` — the actor can read it; the question is
 * whether the destination's audience can. *Rejected:* stripping the basis on
 * move, which is laundering by drag.
 */

/** The destination audience, reduced to one comparable scope. */
export type TransferDestinationScope =
  | { scopeType: 'user'; scopeId: string }
  | { scopeType: 'channel'; scopeId: string }
  | { scopeType: 'team'; scopeId: string }
  | { scopeType: 'project'; scopeId: string }
  | { scopeType: 'organization'; scopeId: string }
  // A `private` space with no personal owner is its own audience: an explicit
  // member list that no basis scope type names. Nothing but an organisation
  // basis can satisfy it, which is the correct, closed answer.
  | { scopeType: 'space'; scopeId: string }

export const destinationScopeForSpace = (
  space: TransferSpaceScope,
): TransferDestinationScope => {
  switch (space.visibility) {
    case 'organization':
      return { scopeType: 'organization', scopeId: space.organizationId }
    case 'project':
      return { scopeType: 'project', scopeId: space.projectId }
    case 'team':
      return space.teamId
        ? { scopeType: 'team', scopeId: space.teamId }
        : { scopeType: 'space', scopeId: space.id }
    case 'channel':
      return space.channelId
        ? { scopeType: 'channel', scopeId: space.channelId }
        : { scopeType: 'space', scopeId: space.id }
    default:
      // `private`. A personal space carries the owner in `user_id`; that is the
      // arm that lets material based on your own space come back to it.
      return space.userId
        ? { scopeType: 'user', scopeId: space.userId }
        : { scopeType: 'space', scopeId: space.id }
  }
}

export type TransferBasisRefusal = {
  pageId: string
  title: string
  versionId: string
  reason: 'basis_scope' | 'unknown_author'
}

type BasisRow = {
  page_id: string
  title: string
  version_id: string
  scope_type: string
  scope_id: string
}

type UnknownAuthorRow = {
  page_id: string
  title: string
  version_id: string
}

const basisSatisfied = (
  basis: { scopeType: string; scopeId: string },
  destination: TransferDestinationScope,
  space: TransferSpaceScope,
): boolean => {
  // Everyone in the organisation may already read it, so no destination inside
  // the organisation can widen past it.
  if (basis.scopeType === 'organization') return true
  // Same audience, by construction.
  if (basis.scopeType === destination.scopeType && basis.scopeId === destination.scopeId) {
    return true
  }
  // Material based on one person's own space may return to that person's space.
  if (basis.scopeType === 'user' && space.userId === basis.scopeId) return true
  // An agent's own home may receive material based on that agent.
  if (basis.scopeType === 'agent' && space.ownerAgentId === basis.scopeId) return true
  return false
}

/**
 * The first version in the subtree whose basis the destination cannot satisfy,
 * or null when every one of them can.
 *
 * Checked over **every retained version**, not just the one a copy carries: the
 * page keeps its history either way, and a version whose basis the destination
 * fails is exactly as readable there as the current one.
 */
export const findTransferBasisRefusal = async (
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string
    pageIds: readonly string[]
    targetSpace: TransferSpaceScope
  },
): Promise<TransferBasisRefusal | null> => {
  if (input.pageIds.length === 0) return null
  const pageIdArray = Prisma.sql`ARRAY[${Prisma.join(
    input.pageIds.map((id) => Prisma.sql`${id}::uuid`),
  )}]`

  // An unknown author is refused before any scope arithmetic: nobody may read
  // material whose source author the disclosure trail could not name, so no
  // destination can be the right one.
  const unknownAuthor = await tx.$queryRaw<UnknownAuthorRow[]>(Prisma.sql`
    SELECT p.id AS page_id, p.title, v.id AS version_id
    FROM knowledge_page_version_disclosure_sources d
    JOIN knowledge_page_versions v ON v.id = d.version_id
    JOIN knowledge_pages p ON p.id = v.page_id
    WHERE p.id = ANY(${pageIdArray})
      AND d.organization_id = ${input.organizationId}::uuid
      AND d.source_author_user_id IS NULL
    LIMIT 1
  `)
  const unknown = unknownAuthor[0]
  if (unknown) {
    return {
      pageId: unknown.page_id,
      title: unknown.title,
      versionId: unknown.version_id,
      reason: 'unknown_author',
    }
  }

  const rows = await tx.$queryRaw<BasisRow[]>(Prisma.sql`
    SELECT p.id AS page_id, p.title, v.id AS version_id, b.scope_type, b.scope_id
    FROM knowledge_page_version_basis_scopes b
    JOIN knowledge_page_versions v ON v.id = b.version_id
    JOIN knowledge_pages p ON p.id = v.page_id
    WHERE p.id = ANY(${pageIdArray})
      AND b.organization_id = ${input.organizationId}::uuid
  `)
  const destination = destinationScopeForSpace(input.targetSpace)
  for (const row of rows) {
    if (basisSatisfied(
      { scopeType: row.scope_type, scopeId: row.scope_id },
      destination,
      input.targetSpace,
    )) {
      continue
    }
    return {
      pageId: row.page_id,
      title: row.title,
      versionId: row.version_id,
      reason: 'basis_scope',
    }
  }
  return null
}

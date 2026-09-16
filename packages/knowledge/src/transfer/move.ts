import { Prisma } from '@prisma/client'

import type { TransferSpaceScope } from './collect.js'

/**
 * A cross-space move, to the row.
 *
 * The load-bearing line of this file is the chunk rewrite. Retrieval filters on
 * `knowledge_page_chunks`' own mirrored scope columns so it never has to join
 * back through mutable page metadata — which means a chunk left on the old
 * scope keeps answering the **old** audience. A moved document would still be
 * findable, by name and by passage, to people who can no longer open it. That
 * is why the pages and the chunks are rewritten in the same transaction and
 * why every caller here takes a `Prisma.TransactionClient` rather than a client
 * it could accidentally run them apart on.
 *
 * `knowledge_page_annotations` denormalises `space_id` for the same
 * listing reason and is rewritten with them.
 *
 * Contract: transfer.md §2 steps 3–6.
 */

export type EndedShare = {
  id: string
  pageId: string
  granteeUserId: string
  spaceId: string
}

export type TransferMoveResult = {
  pagesMoved: number
  chunksMoved: number
  annotationsMoved: number
  endedShares: EndedShare[]
}

export type ApplyTransferMoveInput = {
  organizationId: string
  targetSpace: TransferSpaceScope
  /** Every page in the subtree, roots included. */
  pageIds: readonly string[]
  /** The selected roots, which alone get a new parent and position. */
  rootIds: readonly string[]
  parentPageId: string | null
  /** First free position under `parentPageId` in the destination. */
  startPosition: number
}

const uuidArray = (ids: readonly string[]) =>
  Prisma.sql`ARRAY[${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}]`

export const applyTransferMove = async (
  tx: Prisma.TransactionClient,
  input: ApplyTransferMoveInput,
): Promise<TransferMoveResult> => {
  if (input.pageIds.length === 0) {
    return { pagesMoved: 0, chunksMoved: 0, annotationsMoved: 0, endedShares: [] }
  }
  const pages = uuidArray(input.pageIds)
  const space = input.targetSpace

  // Shares are read before the page rows change, so the rows we report as ended
  // are the ones that actually existed on the subtree in its old home.
  const shares = await tx.knowledgePageShare.findMany({
    where: {
      organizationId: input.organizationId,
      pageId: { in: [...input.pageIds] },
    },
    select: { id: true, pageId: true, granteeUserId: true, spaceId: true },
  })

  // Every scope column from the destination space, and `revision + 1` so an
  // editor holding a stale `If-Match` cannot write through the move. `task_id`
  // is untouched: a task-bound page leaving its project is refused before we
  // get here, and one moving inside its project keeps its ticket.
  const pagesMoved = await tx.$executeRaw(Prisma.sql`
    UPDATE knowledge_pages
    SET space_id = ${space.id}::uuid,
        project_id = ${space.projectId}::uuid,
        team_id = ${space.teamId}::uuid,
        channel_id = ${space.channelId}::uuid,
        thread_id = ${space.threadId}::uuid,
        user_id = ${space.userId}::uuid,
        visibility = ${space.visibility}::"ThoughtVisibility",
        sensitivity_tier = ${space.sensitivityTier}::"SensitivityTier",
        private_to_agent_id = ${space.privateToAgentId}::uuid,
        revision = revision + 1,
        updated_at = now()
    WHERE id = ANY(${pages})
      AND organization_id = ${input.organizationId}::uuid
  `)

  // THE line. Same transaction as the statement above, always.
  const chunksMoved = await tx.$executeRaw(Prisma.sql`
    UPDATE knowledge_page_chunks
    SET project_id = ${space.projectId}::uuid,
        team_id = ${space.teamId}::uuid,
        channel_id = ${space.channelId}::uuid,
        thread_id = ${space.threadId}::uuid,
        user_id = ${space.userId}::uuid,
        visibility = ${space.visibility}::"ThoughtVisibility",
        sensitivity_tier = ${space.sensitivityTier}::"SensitivityTier",
        private_to_agent_id = ${space.privateToAgentId}::uuid,
        updated_at = now()
    WHERE page_id = ANY(${pages})
      AND organization_id = ${input.organizationId}::uuid
  `)

  const annotationsMoved = await tx.$executeRaw(Prisma.sql`
    UPDATE knowledge_page_annotations
    SET space_id = ${space.id}::uuid,
        updated_at = now()
    WHERE page_id = ANY(${pages})
      AND organization_id = ${input.organizationId}::uuid
  `)

  // A share is only ever valid on a page in its owner's personal space, so a
  // page that has left one cannot keep it. Between two non-personal spaces
  // there are none and this deletes nothing.
  if (shares.length > 0) {
    await tx.knowledgePageShare.deleteMany({
      where: { id: { in: shares.map((share) => share.id) } },
    })
  }

  // Only the selected roots are re-parented; descendants keep the parents they
  // had, which is what makes a folder arrive with its contents intact.
  let position = input.startPosition
  for (const rootId of input.rootIds) {
    await tx.$executeRaw(Prisma.sql`
      UPDATE knowledge_pages
      SET parent_page_id = ${input.parentPageId}::uuid,
          position = ${position}
      WHERE id = ${rootId}::uuid
        AND organization_id = ${input.organizationId}::uuid
    `)
    position += 1
  }

  return {
    pagesMoved: Number(pagesMoved),
    chunksMoved: Number(chunksMoved),
    annotationsMoved: Number(annotationsMoved),
    endedShares: shares,
  }
}

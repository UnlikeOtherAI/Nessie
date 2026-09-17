import { Prisma } from '@prisma/client'

import { findTransferBasisRefusal } from './basis-check.js'

/**
 * Reading a transfer before it happens: the destination space's scope columns,
 * the subtree the selection implies, and the two tree locks that keep two
 * concurrent transfers from interleaving.
 *
 * Everything here takes a `Prisma.TransactionClient` so the API's synchronous
 * path and the worker's batched one run exactly the same statements. A second
 * copy of the subtree walk is how a refusal ends up checked against one set of
 * pages and applied to another.
 *
 * Contract: docs/plans/2026-09-16-documents-finder-ui/transfer.md §2 steps 1–2.
 */

// The same bound the Finder's own descendant CTE uses (data-and-api.md §5). A
// tree deeper than this is a cycle someone forced in through the database, and
// an unbounded recursion would hang the request rather than refuse it.
export const TRANSFER_MAX_DEPTH = 64

/** Every scope column a page and its chunk mirrors take from their space. */
export type TransferSpaceScope = {
  id: string
  name: string
  organizationId: string
  projectId: string
  teamId: string | null
  channelId: string | null
  threadId: string | null
  userId: string | null
  visibility: string
  sensitivityTier: string
  privateToAgentId: string | null
  ownerAgentId: string | null
}

export type TransferSubtreeNode = {
  id: string
  parentPageId: string | null
  /** 0 for a selected root; children strictly greater, so a parent-before-child
   * order is `ORDER BY depth`. */
  depth: number
  spaceId: string
  kind: string
  taskId: string | null
  title: string
  status: string
  publishedVersionId: string | null
  isRoot: boolean
}

type SpaceRow = {
  id: string
  name: string
  organization_id: string
  project_id: string
  team_id: string | null
  channel_id: string | null
  thread_id: string | null
  user_id: string | null
  visibility: string
  sensitivity_tier: string
  private_to_agent_id: string | null
  owner_agent_id: string | null
}

type SubtreeRow = {
  id: string
  parent_page_id: string | null
  depth: number
  space_id: string
  kind: string
  task_id: string | null
  title: string
  status: string
  published_version_id: string | null
}

export const loadTransferSpaceScope = async (
  tx: Prisma.TransactionClient,
  organizationId: string,
  spaceId: string,
): Promise<TransferSpaceScope | null> => {
  const rows = await tx.$queryRaw<SpaceRow[]>(Prisma.sql`
    SELECT id, name, organization_id, project_id, team_id, channel_id, thread_id,
           user_id, visibility::text AS visibility,
           sensitivity_tier::text AS sensitivity_tier,
           private_to_agent_id, owner_agent_id
    FROM knowledge_spaces
    WHERE id = ${spaceId}::uuid
      AND organization_id = ${organizationId}::uuid
      AND deleted_at IS NULL
  `)
  const row = rows[0]
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    organizationId: row.organization_id,
    projectId: row.project_id,
    teamId: row.team_id,
    channelId: row.channel_id,
    threadId: row.thread_id,
    userId: row.user_id,
    visibility: row.visibility,
    sensitivityTier: row.sensitivity_tier,
    privateToAgentId: row.private_to_agent_id,
    ownerAgentId: row.owner_agent_id,
  }
}

/**
 * The selected roots plus every live descendant, parent before child.
 *
 * Deliberately de-duplicated by id and keyed on the *smallest* depth at which a
 * page appears: a person may select a folder and something inside it, and a
 * page that arrived twice would be inserted twice by a copy and counted twice
 * by the bound that decides whether this becomes a job.
 */
export const collectTransferSubtree = async (
  tx: Prisma.TransactionClient,
  input: { organizationId: string; pageIds: readonly string[] },
): Promise<TransferSubtreeNode[]> => {
  if (input.pageIds.length === 0) return []
  const roots = new Set(input.pageIds)
  const rows = await tx.$queryRaw<SubtreeRow[]>(Prisma.sql`
    WITH RECURSIVE walk AS (
      SELECT p.id, p.parent_page_id, 0 AS depth
      FROM knowledge_pages p
      WHERE p.id = ANY(${Prisma.sql`ARRAY[${Prisma.join(
        input.pageIds.map((id) => Prisma.sql`${id}::uuid`),
      )}]`})
        AND p.organization_id = ${input.organizationId}::uuid
        AND p.deleted_at IS NULL
      UNION ALL
      SELECT c.id, c.parent_page_id, w.depth + 1
      FROM knowledge_pages c
      JOIN walk w ON c.parent_page_id = w.id
      WHERE c.organization_id = ${input.organizationId}::uuid
        AND c.deleted_at IS NULL
        AND w.depth < ${TRANSFER_MAX_DEPTH}
    ),
    unique_pages AS (
      SELECT id, MIN(depth) AS depth FROM walk GROUP BY id
    )
    SELECT p.id,
           p.parent_page_id,
           u.depth::int AS depth,
           p.space_id,
           p.kind::text AS kind,
           p.task_id,
           p.title,
           p.status::text AS status,
           p.published_version_id
    FROM unique_pages u
    JOIN knowledge_pages p ON p.id = u.id
    ORDER BY u.depth ASC, p.position ASC, p.id ASC
  `)
  return rows.map((row) => ({
    id: row.id,
    parentPageId: row.parent_page_id,
    depth: Number(row.depth),
    spaceId: row.space_id,
    kind: row.kind,
    taskId: row.task_id,
    title: row.title,
    status: row.status,
    publishedVersionId: row.published_version_id,
    isRoot: roots.has(row.id),
  }))
}

/**
 * Serialise this transfer against every other tree write in both spaces.
 *
 * **Lower space id first, always.** Two people dragging in opposite directions
 * between the same two roots take the same two locks; taking them in selection
 * order instead would let each hold the other's and deadlock. The lock key is
 * the one `movePage` already uses (`knowledge_tree_move`), so an in-space move
 * and a cross-space transfer cannot interleave either.
 */
export const lockKnowledgeSpaceTrees = async (
  tx: Prisma.TransactionClient,
  spaceIds: readonly string[],
): Promise<void> => {
  const ordered = Array.from(new Set(spaceIds)).sort()
  for (const spaceId of ordered) {
    await tx.$executeRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(hashtext(${spaceId}), hashtext('knowledge_tree_move'))
    `)
  }
}

/**
 * Every refusal that stays (transfer.md §4), in the order the design fixes,
 * evaluated against the collected subtree with both tree locks already held.
 *
 * It lives here rather than in the route because the worker re-runs exactly
 * these before it starts a queued transfer — the world may have changed since
 * the request — and a second copy of them is how a transfer ends up checked on
 * one set of pages and applied to another. Returns the wire code and the
 * sentence a person can act on; the caller maps the code to a status.
 */
export type TransferRefusal = { code: string; message: string }

export const evaluateTransferRefusals = async (
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string
    nodes: readonly TransferSubtreeNode[]
    sourceProjectId: string
    targetSpace: TransferSpaceScope
    parentPageId: string | null
    /**
     * Which operation is being judged. Defaults to `move`, because a move is
     * the arm with no operation-specific refusals: every rule below holds for
     * both, except the one that is about producing a *new* page.
     */
    operation?: 'move' | 'copy'
  },
): Promise<TransferRefusal | null> => {
  const pageIds = input.nodes.map((node) => node.id)
  if (pageIds.length === 0) {
    return { code: 'KNOWLEDGE_PAGE_NOT_FOUND', message: 'Page not found' }
  }

  if (input.parentPageId && pageIds.includes(input.parentPageId)) {
    return { code: 'TRANSFER_INTO_SELF', message: "A folder can't be moved into itself." }
  }

  // A page already stamped for a queued transfer refuses edits, moves and
  // deletes; starting a second transfer over it is the same refusal.
  const busy = await tx.$queryRaw<Array<{ title: string }>>(Prisma.sql`
    SELECT title FROM knowledge_pages
    WHERE id = ANY(${uuidArraySql(pageIds)})
      AND organization_id = ${input.organizationId}::uuid
      AND metadata -> 'transfer' IS NOT NULL
    LIMIT 1
  `)
  if (busy[0]) {
    return {
      code: 'KNOWLEDGE_MUTATION_CONFLICT',
      message: `“${busy[0].title}” is being moved.`,
    }
  }

  const core = await tx.agentCoreDocument.findFirst({
    where: { pageId: { in: pageIds } },
    select: { pageId: true, agent: { select: { name: true } } },
  })
  if (core) {
    const title = input.nodes.find((node) => node.id === core.pageId)?.title ?? 'This document'
    return {
      code: 'TRANSFER_AGENT_CORE_DOCUMENT',
      message: `“${title}” is ${core.agent.name}'s active instructions and stays with the agent.`,
    }
  }

  // A task folder and its documents may move within their project's Documents
  // space; they may not leave the project the ticket lives in.
  if (input.targetSpace.projectId !== input.sourceProjectId) {
    const bound = input.nodes.find((node) => node.taskId !== null)
    if (bound) {
      const project = await tx.project.findUnique({
        where: { id: input.sourceProjectId },
        select: { name: true },
      })
      return {
        code: 'TRANSFER_TASK_BOUND',
        message:
          `“${bound.title}” belongs to a ticket in ${project?.name ?? 'its project'}`
          + ` and can't leave that project.`,
      }
    }
  }

  // A copy of a spreadsheet would be a page that says `spreadsheet` and cannot
  // be opened. `planTransferCopy` writes the page, its current version and its
  // attachment, and nothing writes the `SpreadsheetHead` that makes a page a
  // workbook (`spreadsheet/create.ts`: "a page with no head is not a
  // spreadsheet, just an unopenable row") — so every spreadsheet route throws
  // on `loadHead` for the copy.
  //
  // A **move** is unaffected and stays allowed: it keeps the page id, so the
  // head, the journal and the filters follow it.
  //
  // Refusing is deliberate rather than provisional. The copy carries only the
  // current version, whose attachment is the `.xlsx` rendition, so the honest
  // implementation is the one the import pipeline already is: stage the
  // rendition and let the worker parse it into a new workbook. That is an
  // asynchronous per-page state the transfer contract does not have yet, and
  // half of it — a page written now, a workbook maybe later — is worse than a
  // sentence saying no.
  if (input.operation === 'copy') {
    const workbook = input.nodes.find((node) => node.kind === 'spreadsheet')
    if (workbook) {
      return {
        code: 'TRANSFER_COPY_SPREADSHEET',
        message: `“${workbook.title}” is a spreadsheet and can be moved, but not copied yet.`,
      }
    }
  }

  const widened = await findTransferBasisRefusal(tx, {
    organizationId: input.organizationId,
    pageIds,
    targetSpace: input.targetSpace,
  })
  if (widened) {
    return {
      code: 'TRANSFER_WIDENS_BASIS',
      message:
        `“${widened.title}” contains material that not everyone in`
        + ` ${input.targetSpace.name} may see.`,
    }
  }

  return null
}

const uuidArraySql = (ids: readonly string[]) =>
  Prisma.sql`ARRAY[${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}]`

/** The next free `position` under a parent in the destination space. */
export const nextTransferPosition = async (
  tx: Prisma.TransactionClient,
  input: { organizationId: string; spaceId: string; parentPageId: string | null },
): Promise<number> => {
  const rows = await tx.$queryRaw<Array<{ next: number | null }>>(Prisma.sql`
    SELECT MAX(position) + 1 AS next
    FROM knowledge_pages
    WHERE organization_id = ${input.organizationId}::uuid
      AND space_id = ${input.spaceId}::uuid
      AND deleted_at IS NULL
      AND parent_page_id IS NOT DISTINCT FROM ${input.parentPageId}::uuid
  `)
  return Number(rows[0]?.next ?? 0)
}

/**
 * Is this a parent a transfer may land on?
 *
 * The same rule `movePage` applies inside one space: a live, unarchived folder
 * or document in the destination. A file node is a blob, and a page filed under
 * one could never be reached again.
 */
export const isValidTransferParent = async (
  tx: Prisma.TransactionClient,
  input: { organizationId: string; spaceId: string; parentPageId: string },
): Promise<boolean> => {
  const parent = await tx.knowledgePage.findFirst({
    where: {
      id: input.parentPageId,
      organizationId: input.organizationId,
      spaceId: input.spaceId,
      deletedAt: null,
      status: { not: 'archived' },
      kind: { in: ['folder', 'document'] },
    },
    select: { id: true },
  })
  return parent !== null
}

/**
 * Stamp `metadata.transfer` on the selected roots (transfer.md §5 step 1).
 *
 * The pages list surfaces this as `transfer` on the record, so the rows read
 * "Moving…"/"Copying…" and refuse edits, moves and deletes while the job runs.
 * Merged into the existing metadata rather than replacing it: a page's own keys
 * are not this job's to discard.
 */
export const stampTransferOnRoots = async (
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string
    rootIds: readonly string[]
    transfer: {
      transferId: string
      operation: 'move' | 'copy'
      targetSpaceId: string
      startedAt: string
    }
  },
): Promise<void> => {
  if (input.rootIds.length === 0) return
  await tx.$executeRaw(Prisma.sql`
    UPDATE knowledge_pages
    SET metadata = COALESCE(metadata, '{}'::jsonb)
      || jsonb_build_object('transfer', ${JSON.stringify(input.transfer)}::jsonb)
    WHERE id = ANY(${uuidArraySql(input.rootIds)})
      AND organization_id = ${input.organizationId}::uuid
  `)
}

/** Remove the stamp — on completion, and on the failure path. */
export const clearTransferStamp = async (
  tx: Prisma.TransactionClient,
  input: { organizationId: string; pageIds: readonly string[] },
): Promise<void> => {
  if (input.pageIds.length === 0) return
  await tx.$executeRaw(Prisma.sql`
    UPDATE knowledge_pages
    SET metadata = metadata - 'transfer'
    WHERE id = ANY(${uuidArraySql(input.pageIds)})
      AND organization_id = ${input.organizationId}::uuid
      AND metadata IS NOT NULL
  `)
}

/**
 * Every attachment the subtree's bytes hang off: a file node's version
 * attachment plus any drawer attachment filed against the page.
 *
 * Both halves matter for a move's ledger pair. Counting only the version
 * attachments would leave a document's uploaded images charged to the space it
 * left.
 */
export const collectTransferAttachmentIds = async (
  tx: Prisma.TransactionClient,
  input: { organizationId: string; pageIds: readonly string[] },
): Promise<string[]> => {
  if (input.pageIds.length === 0) return []
  const pageIds = [...input.pageIds]
  const [versions, drawer] = await Promise.all([
    tx.knowledgePageVersion.findMany({
      where: { pageId: { in: pageIds }, attachmentId: { not: null } },
      select: { attachmentId: true },
    }),
    tx.attachment.findMany({
      where: { knowledgePageId: { in: pageIds }, organizationId: input.organizationId },
      select: { id: true },
    }),
  ])
  const ids = new Set<string>()
  for (const version of versions) {
    if (version.attachmentId) ids.add(version.attachmentId)
  }
  for (const attachment of drawer) ids.add(attachment.id)
  return Array.from(ids)
}

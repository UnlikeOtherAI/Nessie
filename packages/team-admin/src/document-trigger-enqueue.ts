import { Prisma } from '@prisma/client'
import { enqueueQueueJob } from '@nessie/db'
import type { KnowledgePagePublishedEvent, KnowledgeVersionCreatedEvent } from '@nessie/knowledge'
import {
  DocumentChangedStoredConfigSchema,
  documentTriggerPendingKey,
  documentTriggerWatchesPage,
  TRIGGER_DOCUMENT_DISPATCH_TOPIC,
  type DocumentTriggerFireOn,
  type DocumentTriggerScopeFacts,
  type TriggerDocumentDispatchJobPayload,
} from '@nessie/schemas'

/**
 * A saved (or published) version opens each watching document trigger's quiet
 * window (docs/standards/document-triggers.md → "Coalescing").
 *
 * Wired as the knowledge provider's `onVersionCreated` and `onPagePublished`
 * by every process that writes documents, so it runs inside the save: a save
 * cannot commit without its dispatch job, and a failed enqueue rolls the save
 * back. The triggers are found by their indexed `scope_project_id`, so a save
 * no trigger watches costs one indexed read and no queue row.
 *
 * The first save of a window enqueues `trigger.document.dispatch` delayed by
 * the trigger's `quietSeconds`, keyed `doc:<triggerId>:<pageId>:pending`;
 * every later save in the window hits that key and adds nothing. The job reads
 * the page's newest version when it fires, so the saves in between coalesce
 * into one wake. Every save is enqueued, the agent's own included: whose saves
 * wake the agent is the handler's decision, and its own must still move the
 * marker the next wake's diff starts from.
 */

type Writer = Pick<Prisma.TransactionClient, 'agentTrigger' | 'knowledgePage' | 'pageLabel' | '$queryRaw' | '$executeRaw'>

/** The page's folders, nearest first, capped as every tree walk is. */
const ancestorIds = async (tx: Writer, pageId: string): Promise<string[]> => {
  const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    WITH RECURSIVE chain AS (
      SELECT parent_page_id AS id, 1 AS depth FROM knowledge_pages WHERE id = ${pageId}::uuid
      UNION ALL
      SELECT p.parent_page_id, chain.depth + 1
        FROM knowledge_pages p JOIN chain ON p.id = chain.id
       WHERE chain.depth < 64
    )
    SELECT id::text AS id FROM chain WHERE id IS NOT NULL ORDER BY depth
  `)
  return rows.map((row) => row.id)
}

const WATCHABLE_KINDS: ReadonlySet<string> = new Set(['document', 'file'])

export const enqueueDocumentTriggerDispatch = async (
  tx: Writer,
  event: {
    organizationId: string
    projectId: string
    spaceId: string
    pageId: string
    kind: string
    fireOn: DocumentTriggerFireOn
  },
): Promise<void> => {
  // A spreadsheet's saves are live cell edits, and a folder has no content.
  if (!WATCHABLE_KINDS.has(event.kind)) return
  const triggers = await tx.agentTrigger.findMany({
    where: { type: 'document_changed', enabled: true, status: 'active', scopeProjectId: event.projectId },
    select: { id: true, config: true },
  })
  if (triggers.length === 0) return
  let facts: DocumentTriggerScopeFacts | null = null
  const pageFacts = async (): Promise<DocumentTriggerScopeFacts> => {
    facts ??= {
      spaceId: event.spaceId,
      kind: event.kind,
      pageId: event.pageId,
      ancestorIds: await ancestorIds(tx, event.pageId),
      labels: (await tx.pageLabel.findMany({ where: { pageId: event.pageId }, select: { name: true } }))
        .map((label) => label.name),
    }
    return facts
  }
  for (const trigger of triggers) {
    const config = DocumentChangedStoredConfigSchema.safeParse(trigger.config)
    // A config that no longer parses is the handler's to report; nothing here
    // can match it, and a save must never fail because a trigger is broken.
    if (!config.success || config.data.fireOn !== event.fireOn || config.data.spaceId !== event.spaceId) continue
    if (!documentTriggerWatchesPage(config.data, await pageFacts())) continue
    const payload: TriggerDocumentDispatchJobPayload = {
      organizationId: event.organizationId,
      pageId: event.pageId,
      triggerId: trigger.id,
    }
    await enqueueQueueJob(tx, {
      delayMs: config.data.quietSeconds * 1_000,
      idempotencyKey: documentTriggerPendingKey(trigger.id, event.pageId),
      payload,
      topic: TRIGGER_DOCUMENT_DISPATCH_TOPIC,
    })
  }
}

/** `onVersionCreated`, as every document-writing process wires it. */
export const documentTriggerOnVersionCreated = (
  tx: Prisma.TransactionClient,
  event: KnowledgeVersionCreatedEvent,
): Promise<void> => enqueueDocumentTriggerDispatch(tx, { ...event, fireOn: 'save' })

/** `onPagePublished`'s document-trigger half: only a trigger that fires on publish. */
export const documentTriggerOnPagePublished = async (
  tx: Prisma.TransactionClient,
  event: KnowledgePagePublishedEvent,
): Promise<void> => {
  const page = await tx.knowledgePage.findUnique({ where: { id: event.pageId }, select: { kind: true } })
  if (!page) return
  await enqueueDocumentTriggerDispatch(tx, { ...event, kind: page.kind, fireOn: 'publish' })
}

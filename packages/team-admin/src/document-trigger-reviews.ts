import { Prisma, type PrismaClient } from '@prisma/client'
import { listVisibleAgentIdsForUser } from '@nessie/db'
import {
  DocumentTriggerDeliveryPayloadSchema,
  type DocumentReviewRecord,
} from '@nessie/schemas'

import { buildViewerThreadWhere } from './agent-conversations.js'

/**
 * The Finder's and the project Docs tab's row badge: *"Sent to CTO for review
 * · v5"*, then *"Reviewed by CTO · v5"* (docs/standards/document-triggers.md
 * → "What a person sees").
 *
 * For each page the viewer asked about — the caller has already checked the
 * viewer may read them — the newest delivered wake of a document trigger in
 * this organisation **whose agent the viewer may see**: a newer wake of an
 * agent hidden from the viewer is passed over for the newest they may see,
 * rather than taking the page's badge away. `reviewed` once a run that took
 * the change in completed — the run the delivery started, or one in the same
 * thread started after it was delivered (a wake folded into a pending ticket
 * kickoff) — and `sent` until then. The thread the review happened in is
 * linked only when the viewer may open it; a viewer who may not gets the
 * badge and no door. Nothing of the document travels: the delivery row
 * carries metadata only.
 */

type Row = {
  page_id: string
  trigger_id: string
  agent_id: string
  agent_name: string
  payload: Prisma.JsonValue
  delivered_at: Date
  reviewed: boolean
}

export const loadDocumentReviews = async (
  prisma: PrismaClient,
  input: { organizationId: string; pageIds: readonly string[]; viewerUserId: string },
): Promise<DocumentReviewRecord[]> => {
  if (input.pageIds.length === 0) return []
  const visibleAgents = await listVisibleAgentIdsForUser(prisma, {
    organizationId: input.organizationId,
    userId: input.viewerUserId,
  })
  if (visibleAgents.length === 0) return []
  const rows = await prisma.$queryRaw<Row[]>(Prisma.sql`
    SELECT DISTINCT ON (d.payload->>'pageId')
           d.payload->>'pageId' AS page_id, d.trigger_id::text AS trigger_id, a.id::text AS agent_id,
           a.name AS agent_name, d.payload, d.delivered_at,
           EXISTS (
             SELECT 1 FROM runs r
              WHERE r.status = 'completed'
                AND (r.trigger_delivery_id = d.id
                  OR (r.thread_id::text = d.payload->>'threadId' AND r.started_at >= d.delivered_at))
           ) AS reviewed
      FROM agent_trigger_deliveries d
      JOIN agent_triggers t ON t.id = d.trigger_id
      JOIN agents a ON a.id = t.agent_id
     WHERE t.type = 'document_changed'
       AND a.organization_id = ${input.organizationId}::uuid
       AND a.id::text = ANY(${visibleAgents}::text[])
       AND d.status = 'delivered'
       AND d.delivered_at IS NOT NULL
       AND d.payload->>'pageId' = ANY(${[...input.pageIds]}::text[])
     ORDER BY d.payload->>'pageId', d.delivered_at DESC
  `)
  const parsed = rows.flatMap((row) => {
    const payload = DocumentTriggerDeliveryPayloadSchema.safeParse(row.payload)
    return payload.success ? [{ row, payload: payload.data }] : []
  })
  const threadIds = parsed.flatMap(({ payload }) => (payload.threadId ? [payload.threadId] : []))
  const openable = new Map((threadIds.length === 0 ? [] : await prisma.thread.findMany({
    where: { id: { in: threadIds }, ...buildViewerThreadWhere(input.viewerUserId, input.organizationId) },
    select: { id: true, channelId: true },
  })).map((thread) => [thread.id, thread.channelId]))
  return parsed.map(({ row, payload }) => {
    const channelId = payload.threadId ? openable.get(payload.threadId) : undefined
    return {
      pageId: row.page_id,
      triggerId: row.trigger_id,
      agent: { id: row.agent_id, name: row.agent_name },
      versionNumber: payload.toVersionNumber,
      state: row.reviewed ? 'reviewed' : 'sent',
      sentAt: row.delivered_at.toISOString(),
      thread: payload.threadId && channelId ? { id: payload.threadId, channelId } : null,
    }
  })
}

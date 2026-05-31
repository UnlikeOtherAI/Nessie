import type {
  ThoughtAudienceType,
  ThoughtRecallUserSignal,
  ThoughtSearchMode,
} from '@nessie/schemas'
import {
  markRecallLedgerInjected,
  markRecallLedgerReferenced,
  THOUGHT_RECALL_LEDGER,
  writeRecallLedgerEntries,
  type RecallLedgerEntry,
} from '@nessie/retrieval'
import type { Pool } from 'pg'

type Queryable = Pick<Pool, 'query'>

export type RecallLogEntry = {
  thoughtId: string
  // Null for autonomous agent runs that have no requesting user.
  requesterUserId: string | null
  sessionId?: string
  channelId?: string
  // Null for multi-scope (per-agent) recalls, which span several audiences
  // rather than a single output audience.
  outputAudienceType: ThoughtAudienceType | null
  outputAudienceId: string | null
  queryText: string
  queryEmbedding: number[] | null
  similarity: number
  rankPosition: number
  retrievalMode: ThoughtSearchMode
  wasInjected?: boolean
  wasReferenced?: boolean
}

export type LoggedRecall = {
  id: string
  thoughtId: string
  rankPosition: number
  retrievalMode: ThoughtSearchMode
}

export type RecordRecallSignalInput = {
  recallId: string
  organizationId: string
  requesterUserId: string
  userSignal: ThoughtRecallUserSignal
}

export const logRecalls = async (
  entries: RecallLogEntry[],
  db: Queryable,
): Promise<LoggedRecall[]> => {
  const ledgerEntries: RecallLedgerEntry[] = entries.map((entry) => ({
    channelId: entry.channelId,
    contentId: entry.thoughtId,
    outputAudienceId: entry.outputAudienceId,
    outputAudienceType: entry.outputAudienceType,
    queryEmbedding: entry.queryEmbedding,
    queryText: entry.queryText,
    rankPosition: entry.rankPosition,
    requesterUserId: entry.requesterUserId,
    retrievalMode: entry.retrievalMode,
    sessionId: entry.sessionId,
    similarity: entry.similarity,
    wasInjected: entry.wasInjected,
    wasReferenced: entry.wasReferenced,
  }))
  const logged = await writeRecallLedgerEntries(
    THOUGHT_RECALL_LEDGER,
    ledgerEntries,
    db,
  )

  return logged.map((recall) => ({
    id: recall.id,
    rankPosition: recall.rankPosition,
    retrievalMode: recall.retrievalMode as ThoughtSearchMode,
    thoughtId: recall.contentId,
  }))
}

export const recordRecallSignal = async (
  input: RecordRecallSignalInput,
  db: Queryable,
): Promise<boolean> => {
  const result = await db.query(
    `UPDATE thought_recalls AS tr
     SET user_signal = $1
     FROM thoughts AS t
     WHERE tr.id = $2
       AND tr.thought_id = t.id
       AND t.organization_id = $3
       AND (tr.requester_user_id IS NULL OR tr.requester_user_id = $4::uuid)
       AND thought_requester_has_access(
         $4::uuid,
         resolve_thought_audience_type(
           t.audience_type,
           t.visibility,
           t.owner_type,
           t.owner_id,
           t.user_id,
           t.organization_id,
           t.project_id,
           t.team_id,
           t.channel_id
         ),
         resolve_thought_audience_id(
           t.audience_id,
           resolve_thought_audience_type(
             t.audience_type,
             t.visibility,
             t.owner_type,
             t.owner_id,
             t.user_id,
             t.organization_id,
             t.project_id,
             t.team_id,
             t.channel_id
           ),
           t.organization_id,
           t.project_id,
           t.team_id,
           t.channel_id,
           t.user_id,
           t.owner_type,
           t.owner_id
         ),
         t.organization_id
       )
       AND (
         tr.output_audience_type IS NULL
         OR tr.output_audience_id IS NULL
         OR thought_audience_compatible_with_output(
           resolve_thought_audience_type(
             t.audience_type,
             t.visibility,
             t.owner_type,
             t.owner_id,
             t.user_id,
             t.organization_id,
             t.project_id,
             t.team_id,
             t.channel_id
           ),
           resolve_thought_audience_id(
             t.audience_id,
             resolve_thought_audience_type(
               t.audience_type,
               t.visibility,
               t.owner_type,
               t.owner_id,
               t.user_id,
               t.organization_id,
               t.project_id,
               t.team_id,
               t.channel_id
             ),
             t.organization_id,
             t.project_id,
             t.team_id,
             t.channel_id,
             t.user_id,
             t.owner_type,
             t.owner_id
           ),
           tr.output_audience_type,
           tr.output_audience_id,
           t.organization_id
         )
       )
       AND t.deleted_at IS NULL
     RETURNING tr.id`,
    [
      input.userSignal,
      input.recallId,
      input.organizationId,
      input.requesterUserId,
    ],
  )

  return result.rowCount !== null && result.rowCount > 0
}

export const markRecallsInjected = async (
  recallIds: string[],
  db: Queryable,
): Promise<number> =>
  markRecallLedgerInjected(THOUGHT_RECALL_LEDGER, recallIds, db)

export const markRecallsReferenced = async (
  recallIds: string[],
  db: Queryable,
): Promise<number> =>
  markRecallLedgerReferenced(THOUGHT_RECALL_LEDGER, recallIds, db)

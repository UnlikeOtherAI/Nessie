import type {
  ThoughtAudienceType,
  ThoughtRecallUserSignal,
  ThoughtSearchMode,
} from '@nessie/schemas'
import type { Pool } from 'pg'

type Queryable = Pick<Pool, 'query'>

export type RecallLogEntry = {
  thoughtId: string
  requesterUserId: string
  sessionId?: string
  channelId?: string
  outputAudienceType: ThoughtAudienceType
  outputAudienceId: string
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

const toVectorLiteral = (embedding: number[] | null): string | null =>
  embedding ? `[${embedding.join(',')}]` : null

export const logRecalls = async (
  entries: RecallLogEntry[],
  db: Queryable,
): Promise<LoggedRecall[]> => {
  if (entries.length === 0) {
    return []
  }

  const result = await db.query(
    `INSERT INTO thought_recalls (
       id,
       thought_id,
       requester_user_id,
       session_id,
       channel_id,
       output_audience_type,
       output_audience_id,
       query_text,
       query_embedding,
       similarity,
       rank_position,
       retrieval_mode,
       was_injected,
       was_referenced
     )
     SELECT
       gen_random_uuid(),
       recall.thought_id,
       recall.requester_user_id,
       recall.session_id,
       recall.channel_id,
       recall.output_audience_type,
       recall.output_audience_id,
       recall.query_text,
       CASE
         WHEN recall.query_embedding IS NULL THEN NULL
         ELSE recall.query_embedding::vector
       END,
       recall.similarity,
       recall.rank_position,
       recall.retrieval_mode,
       recall.was_injected,
       recall.was_referenced
     FROM unnest(
       $1::uuid[],
       $2::uuid[],
       $3::text[],
       $4::uuid[],
       $5::"ThoughtAudienceType"[],
       $6::uuid[],
       $7::text[],
       $8::text[],
       $9::float8[],
       $10::int[],
       $11::text[],
       $12::boolean[],
       $13::boolean[]
     ) AS recall(
       thought_id,
       requester_user_id,
       session_id,
       channel_id,
       output_audience_type,
       output_audience_id,
       query_text,
       query_embedding,
       similarity,
       rank_position,
       retrieval_mode,
       was_injected,
       was_referenced
     )
     RETURNING
       id,
       thought_id AS "thoughtId",
       rank_position AS "rankPosition",
       retrieval_mode AS "retrievalMode"`,
    [
      entries.map((entry) => entry.thoughtId),
      entries.map((entry) => entry.requesterUserId),
      entries.map((entry) => entry.sessionId ?? null),
      entries.map((entry) => entry.channelId ?? null),
      entries.map((entry) => entry.outputAudienceType),
      entries.map((entry) => entry.outputAudienceId),
      entries.map((entry) => entry.queryText),
      entries.map((entry) => toVectorLiteral(entry.queryEmbedding)),
      entries.map((entry) => entry.similarity),
      entries.map((entry) => entry.rankPosition),
      entries.map((entry) => entry.retrievalMode),
      entries.map((entry) => entry.wasInjected ?? false),
      entries.map((entry) => entry.wasReferenced ?? false),
    ],
  )

  return result.rows as LoggedRecall[]
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
): Promise<number> => {
  if (recallIds.length === 0) {
    return 0
  }

  const result = await db.query(
    `UPDATE thought_recalls
     SET was_injected = true
     WHERE id = ANY($1::uuid[])`,
    [recallIds],
  )

  return result.rowCount ?? 0
}

export const markRecallsReferenced = async (
  recallIds: string[],
  db: Queryable,
): Promise<number> => {
  if (recallIds.length === 0) {
    return 0
  }

  const result = await db.query(
    `UPDATE thought_recalls
     SET was_referenced = true
     WHERE id = ANY($1::uuid[])`,
    [recallIds],
  )

  return result.rowCount ?? 0
}

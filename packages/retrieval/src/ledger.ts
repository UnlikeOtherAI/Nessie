import type { Queryable } from './query.js'
import { toVectorLiteral } from './query.js'

export type RecallLedgerDefinition = {
  audienceTypeSqlType: string
  contentIdColumn: string
  contentIdResultAlias: string
  tableName: string
}

export type RecallLedgerEntry = {
  contentId: string
  requesterUserId: string | null
  sessionId?: string
  channelId?: string
  outputAudienceType: string | null
  outputAudienceId: string | null
  queryText: string
  queryEmbedding: number[] | null
  similarity: number
  rankPosition: number
  retrievalMode: string
  wasInjected?: boolean
  wasReferenced?: boolean
}

export type LoggedRecallLedgerEntry = {
  id: string
  contentId: string
  rankPosition: number
  retrievalMode: string
}

const IDENTIFIER_RE = /^[a-z][a-z0-9_]*$/
const RESULT_ALIAS_RE = /^[A-Za-z][A-Za-z0-9_]*$/
const SQL_TYPE_RE = /^"?[A-Za-z][A-Za-z0-9_]*"?$/

const validateSqlIdentifier = (identifier: string): string => {
  if (!IDENTIFIER_RE.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`)
  }

  return identifier
}

const validateResultAlias = (alias: string): string => {
  if (!RESULT_ALIAS_RE.test(alias)) {
    throw new Error(`Unsafe SQL result alias: ${alias}`)
  }

  return alias
}

const validateSqlType = (typeName: string): string => {
  if (!SQL_TYPE_RE.test(typeName)) {
    throw new Error(`Unsafe SQL type: ${typeName}`)
  }

  return typeName
}

const validateLedgerDefinition = (
  definition: RecallLedgerDefinition,
): RecallLedgerDefinition => ({
  audienceTypeSqlType: validateSqlType(definition.audienceTypeSqlType),
  contentIdColumn: validateSqlIdentifier(definition.contentIdColumn),
  contentIdResultAlias: validateResultAlias(definition.contentIdResultAlias),
  tableName: validateSqlIdentifier(definition.tableName),
})

export const THOUGHT_RECALL_LEDGER = validateLedgerDefinition({
  audienceTypeSqlType: '"ThoughtAudienceType"',
  contentIdColumn: 'thought_id',
  contentIdResultAlias: 'thoughtId',
  tableName: 'thought_recalls',
})

type RawLoggedRecallLedgerEntry = {
  id: string
  rankPosition: number
  retrievalMode: string
  [key: string]: unknown
}

const normalizeLoggedRecallRows = (
  rows: RawLoggedRecallLedgerEntry[],
  contentIdResultAlias: string,
): LoggedRecallLedgerEntry[] =>
  rows.map((row) => {
    const contentId = row.contentId ?? row[contentIdResultAlias]
    if (typeof contentId !== 'string') {
      throw new Error(`Recall ledger row is missing ${contentIdResultAlias}`)
    }

    return {
      contentId,
      id: row.id,
      rankPosition: row.rankPosition,
      retrievalMode: row.retrievalMode,
    }
  })

export const writeRecallLedgerEntries = async (
  definition: RecallLedgerDefinition,
  entries: RecallLedgerEntry[],
  db: Queryable,
): Promise<LoggedRecallLedgerEntry[]> => {
  if (entries.length === 0) {
    return []
  }

  const ledger = validateLedgerDefinition(definition)
  const result = await db.query(
    `INSERT INTO ${ledger.tableName} (
       id,
       ${ledger.contentIdColumn},
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
       recall.content_id,
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
       $5::${ledger.audienceTypeSqlType}[],
       $6::uuid[],
       $7::text[],
       $8::text[],
       $9::float8[],
       $10::int[],
       $11::text[],
       $12::boolean[],
       $13::boolean[]
     ) AS recall(
       content_id,
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
       ${ledger.contentIdColumn} AS "contentId",
       ${ledger.contentIdColumn} AS "${ledger.contentIdResultAlias}",
       rank_position AS "rankPosition",
       retrieval_mode AS "retrievalMode"`,
    [
      entries.map((entry) => entry.contentId),
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

  return normalizeLoggedRecallRows(
    result.rows as RawLoggedRecallLedgerEntry[],
    ledger.contentIdResultAlias,
  )
}

const markRecallLedgerFlag = async (
  definition: RecallLedgerDefinition,
  recallIds: string[],
  flagColumn: 'was_injected' | 'was_referenced',
  db: Queryable,
): Promise<number> => {
  if (recallIds.length === 0) {
    return 0
  }

  const ledger = validateLedgerDefinition(definition)
  const result = await db.query(
    `UPDATE ${ledger.tableName}
     SET ${flagColumn} = true
     WHERE id = ANY($1::uuid[])`,
    [recallIds],
  )

  return result.rowCount ?? 0
}

export const markRecallLedgerInjected = async (
  definition: RecallLedgerDefinition,
  recallIds: string[],
  db: Queryable,
): Promise<number> =>
  markRecallLedgerFlag(definition, recallIds, 'was_injected', db)

export const markRecallLedgerReferenced = async (
  definition: RecallLedgerDefinition,
  recallIds: string[],
  db: Queryable,
): Promise<number> =>
  markRecallLedgerFlag(definition, recallIds, 'was_referenced', db)

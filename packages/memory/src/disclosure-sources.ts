import type { PoolClient } from 'pg'

export type PrivateConversationSource = {
  sourceAuthorUserId: string | null
  sourceChannelId: string
}

export type ThoughtDisclosureSource = PrivateConversationSource & {
  thoughtId: string
}

export type ThoughtDisclosureLineage = {
  audienceId: string | null
  audienceType: string | null
  sources: PrivateConversationSource[]
  thoughtId: string
}

type Queryable = {
  query: (
    sql: string,
    values?: readonly unknown[],
  ) => Promise<{ rows: unknown[] }>
}

const sourceKey = (source: PrivateConversationSource): string =>
  `${source.sourceChannelId}:${source.sourceAuthorUserId ?? 'unknown'}`

export const uniquePrivateConversationSources = (
  sources: readonly PrivateConversationSource[],
): PrivateConversationSource[] => {
  const unique = new Map<string, PrivateConversationSource>()
  for (const source of sources) {
    if (!source.sourceChannelId) continue
    const key = sourceKey(source)
    if (!unique.has(key)) unique.set(key, source)
  }
  return [...unique.values()]
}

export const insertThoughtDisclosureSources = async (
  client: PoolClient,
  input: {
    organizationId: string
    sources: readonly PrivateConversationSource[]
    thoughtId: string
  },
): Promise<void> => {
  const sources = uniquePrivateConversationSources(input.sources)
  for (const source of sources) {
    await client.query(
      `INSERT INTO thought_disclosure_sources (
        id, thought_id, organization_id, source_channel_id, source_author_user_id, created_at
      )
      SELECT gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4::uuid, now()
      WHERE NOT EXISTS (
        SELECT 1
        FROM thought_disclosure_sources
        WHERE thought_id = $1::uuid
          AND source_channel_id = $3::uuid
          AND source_author_user_id IS NOT DISTINCT FROM $4::uuid
      )`,
      [
        input.thoughtId,
        input.organizationId,
        source.sourceChannelId,
        source.sourceAuthorUserId,
      ],
    )
  }
}

export const loadThoughtDisclosureSources = async (
  db: Queryable,
  thoughtIds: readonly string[],
): Promise<ThoughtDisclosureSource[]> => {
  if (thoughtIds.length === 0) return []
  const result = await db.query(
    `SELECT
       thought_id AS "thoughtId",
       source_channel_id AS "sourceChannelId",
       source_author_user_id AS "sourceAuthorUserId"
     FROM thought_disclosure_sources
     WHERE thought_id = ANY($1::uuid[])`,
    [[...thoughtIds]],
  )
  return result.rows as ThoughtDisclosureSource[]
}

export const loadThoughtDisclosureLineage = async (
  db: Queryable,
  thoughtIds: readonly string[],
): Promise<ThoughtDisclosureLineage[]> => {
  if (thoughtIds.length === 0) return []
  const result = await db.query(
    `SELECT
       t.id AS "thoughtId",
       t.audience_type AS "audienceType",
       t.audience_id AS "audienceId",
       tds.source_channel_id AS "sourceChannelId",
       tds.source_author_user_id AS "sourceAuthorUserId"
     FROM thoughts t
     LEFT JOIN thought_disclosure_sources tds ON tds.thought_id = t.id
     WHERE t.id = ANY($1::uuid[])`,
    [[...thoughtIds]],
  )
  const lineages = new Map<string, ThoughtDisclosureLineage>()
  for (const row of result.rows as Array<ThoughtDisclosureSource & {
    audienceId: string | null
    audienceType: string | null
  }>) {
    const lineage = lineages.get(row.thoughtId) ?? {
      audienceId: row.audienceId,
      audienceType: row.audienceType,
      sources: [],
      thoughtId: row.thoughtId,
    }
    if (row.sourceChannelId) {
      lineage.sources.push({
        sourceAuthorUserId: row.sourceAuthorUserId,
        sourceChannelId: row.sourceChannelId,
      })
    }
    lineages.set(row.thoughtId, lineage)
  }
  return [...lineages.values()]
}

import type { Pool } from 'pg'

// --- Outcome Tracking ---

export type RecordOutcomeInput = {
  thoughtId: string
  organizationId: string
  outcome: 'successful' | 'partially' | 'failed' | 'superseded'
  outcomeNotes?: string
  actorType: string
  actorId: string
}

export const recordOutcome = async (
  input: RecordOutcomeInput,
  pool: Pool,
): Promise<void> => {
  const result = await pool.query(
    `UPDATE thought_reasonings AS tr
     SET outcome = $1, outcome_notes = $2, outcome_at = now(), updated_at = now()
     FROM thoughts AS t
     WHERE tr.thought_id = $3
       AND tr.thought_id = t.id
       AND t.organization_id = $4::uuid
       AND tr.outcome = 'pending'
     RETURNING id`,
    [
      input.outcome,
      input.outcomeNotes ?? null,
      input.thoughtId,
      input.organizationId,
    ],
  )

  await pool.query(
    `INSERT INTO thought_audit_logs (id, thought_id, action, actor_type, actor_id, diff, created_at)
     VALUES (gen_random_uuid(), $1, 'outcome_recorded', $2, $3, $4, now())`,
    [
      input.thoughtId,
      input.actorType,
      input.actorId,
      JSON.stringify({
        outcome: input.outcome,
        outcomeNotes: input.outcomeNotes,
        reasoningsUpdated: result.rowCount,
      }),
    ],
  )
}

// --- Thought Linking ---

export type LinkThoughtsInput = {
  sourceId: string
  targetId: string
  organizationId: string
  relation: 'supersedes' | 'derived_from' | 'contradicts' | 'supports' | 'relates_to'
  metadata?: Record<string, unknown>
  actorType: string
  actorId: string
}

export const linkThoughts = async (
  input: LinkThoughtsInput,
  pool: Pool,
): Promise<string> => {
  const result = await pool.query(
    `INSERT INTO thought_links (id, source_id, target_id, relation, metadata, created_at)
     SELECT gen_random_uuid(), source.id, target.id, $3, $4, now()
     FROM thoughts AS source
     CROSS JOIN thoughts AS target
     WHERE source.id = $1
       AND target.id = $2
       AND source.organization_id = $5::uuid
       AND target.organization_id = $5::uuid
     ON CONFLICT (source_id, target_id, relation) DO NOTHING
     RETURNING id`,
    [
      input.sourceId,
      input.targetId,
      input.relation,
      input.metadata ? JSON.stringify(input.metadata) : null,
      input.organizationId,
    ],
  )

  const insertedRow = result.rows[0] as { id: string } | undefined
  if (!insertedRow) {
    return '' // Link already exists (ON CONFLICT DO NOTHING)
  }
  const linkId = insertedRow.id

  if (input.relation === 'supersedes') {
    await pool.query(
      `UPDATE thought_reasonings
       SET outcome = 'superseded',
           outcome_notes = 'Superseded by thought ' || $1,
           outcome_at = now(),
           updated_at = now()
       WHERE thought_id = $2
         AND outcome = 'pending'
         AND EXISTS (
           SELECT 1
           FROM thoughts AS t
           WHERE t.id = $2
             AND t.organization_id = $3::uuid
         )`,
      [input.sourceId, input.targetId, input.organizationId],
    )
  }

  await pool.query(
    `INSERT INTO thought_audit_logs (id, thought_id, action, actor_type, actor_id, diff, created_at)
     VALUES (gen_random_uuid(), $1, 'linked', $2, $3, $4, now())`,
    [
      input.sourceId,
      input.actorType,
      input.actorId,
      JSON.stringify({ relation: input.relation, targetId: input.targetId }),
    ],
  )

  return linkId
}

// --- Experience Query ---

export type ExperienceStats = {
  totalDecisions: number
  successful: number
  failed: number
  pending: number
  successRate: number
}

export const getExperienceStats = async (
  organizationId: string,
  actorId: string | null,
  pool: Pool,
): Promise<ExperienceStats> => {
  const whereClause = actorId
    ? 'WHERE organization_id = $1 AND actor_id = $2'
    : 'WHERE organization_id = $1'
  const params = actorId ? [organizationId, actorId] : [organizationId]

  const result = await pool.query(
    `SELECT
       count(*) FILTER (WHERE outcome != 'pending') AS total_decisions,
       count(*) FILTER (WHERE outcome = 'successful') AS successful,
       count(*) FILTER (WHERE outcome = 'failed') AS failed,
       count(*) FILTER (WHERE outcome = 'pending') AS pending
     FROM thought_reasonings
     ${whereClause}`,
    params,
  )

  const row = result.rows[0] as {
    total_decisions: string
    successful: string
    failed: string
    pending: string
  } | undefined

  const total = Number(row?.total_decisions ?? 0)
  const successful = Number(row?.successful ?? 0)
  const failed = Number(row?.failed ?? 0)
  const pending = Number(row?.pending ?? 0)

  return {
    totalDecisions: total,
    successful,
    failed,
    pending,
    successRate: total > 0 ? successful / total : 0,
  }
}

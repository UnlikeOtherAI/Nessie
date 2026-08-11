import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { EMBEDDING_DIMENSIONS } from '@nessie/schemas'
import { Pool } from 'pg'

const vectorLiteral = (): string =>
  `[${[1, ...Array<number>(EMBEDDING_DIMENSIONS - 1).fill(0)].join(',')}]`

const runIfDatabase = process.env.DATABASE_URL ? test : test.skip

runIfDatabase('scoped recall denies channel and team memories in incompatible audiences', async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const ids = {
    agent: randomUUID(),
    currentChannel: randomUUID(),
    outsider: randomUUID(),
    org: randomUUID(),
    project: randomUUID(),
    sourceChannel: randomUUID(),
    team: randomUUID(),
    teamThought: randomUUID(),
    userA: randomUUID(),
    userB: randomUUID(),
    writtenThought: randomUUID(),
  }

  try {
    await pool.query(
      `INSERT INTO users (id, email, display_name, created_at, updated_at)
       VALUES
         ($1, $2, 'User A', now(), now()),
         ($3, $4, 'User B', now(), now()),
         ($5, $6, 'Outsider', now(), now())`,
      [
        ids.userA,
        `${ids.userA}@example.test`,
        ids.userB,
        `${ids.userB}@example.test`,
        ids.outsider,
        `${ids.outsider}@example.test`,
      ],
    )
    await pool.query(
      `INSERT INTO organizations (id, name, created_at, updated_at)
       VALUES ($1, 'Deny Bias Org', now(), now())`,
      [ids.org],
    )
    await pool.query(
      `INSERT INTO organization_members (id, organization_id, user_id, role, created_at)
       VALUES
         ($1, $2, $3, 'member', now()),
         ($4, $2, $5, 'member', now()),
         ($6, $2, $7, 'member', now())`,
      [
        randomUUID(),
        ids.org,
        ids.userA,
        randomUUID(),
        ids.userB,
        randomUUID(),
        ids.outsider,
      ],
    )
    await pool.query(
      `INSERT INTO projects (id, name, organization_id, created_at, updated_at)
       VALUES ($1, 'Deny Bias Project', $2, now(), now())`,
      [ids.project, ids.org],
    )
    await pool.query(
      `INSERT INTO teams (id, name, project_id, created_at, updated_at)
       VALUES ($1, 'Management', $2, now(), now())`,
      [ids.team, ids.project],
    )
    await pool.query(
      `INSERT INTO team_members (id, team_id, user_id, role, created_at)
       VALUES ($1, $2, $3, 'member', now()), ($4, $2, $5, 'member', now())`,
      [randomUUID(), ids.team, ids.userA, randomUUID(), ids.userB],
    )
    await pool.query(
      `INSERT INTO channels (id, label, organization_id, project_id, team_id, slug, created_at, updated_at)
       VALUES
         ($1, 'management-private', $2, $3, $4, 'management-private', now(), now()),
         ($5, 'client-shared', $2, $3, $4, 'client-shared', now(), now())`,
      [ids.sourceChannel, ids.org, ids.project, ids.team, ids.currentChannel],
    )
    await pool.query(
      `INSERT INTO channel_members (id, channel_id, user_id, created_at)
       VALUES
         ($1, $2, $3, now()),
         ($4, $2, $5, now()),
         ($6, $7, $3, now()),
         ($8, $7, $9, now())`,
      [
        randomUUID(),
        ids.sourceChannel,
        ids.userA,
        randomUUID(),
        ids.userB,
        randomUUID(),
        ids.currentChannel,
        randomUUID(),
        ids.outsider,
      ],
    )
    await pool.query(
      `INSERT INTO thoughts (
         id, content, content_hash, embedding, owner_id, owner_type,
         audience_type, audience_id, organization_id, project_id, team_id,
         channel_id, visibility, sensitivity_tier, importance, metadata,
         embedding_model, dims, created_at, updated_at
       )
       VALUES
         (
           $1, 'Layoff planning remains confidential to management.',
           $2, $3::vector, $4, 'service', 'channel', $5,
           $6, $7, $8, $5, 'channel', 'normal', 0.9, '{}'::jsonb,
           'test-embedding', ${EMBEDDING_DIMENSIONS}, now(), now()
         ),
         (
           $9, 'Management budget constraint is confidential.',
           $10, $3::vector, $4, 'service', 'team', $8,
           $6, $7, $8, NULL, 'team', 'normal', 0.9, '{}'::jsonb,
           'test-embedding', ${EMBEDDING_DIMENSIONS}, now(), now()
         )`,
      [
        ids.writtenThought,
        `hash-${ids.writtenThought}`,
        vectorLiteral(),
        ids.agent,
        ids.sourceChannel,
        ids.org,
        ids.project,
        ids.team,
        ids.teamThought,
        `hash-${ids.teamThought}`,
      ],
    )

    const incompatible = await pool.query(
      `SELECT id
       FROM match_thoughts_in_scopes(
         $1::vector,
         'confidential management',
         $2::uuid,
         ARRAY['channel', 'team']::text[],
         ARRAY[$3::uuid, $4::uuid],
         'channel'::"ThoughtAudienceType",
         $5::uuid,
         $6::uuid,
         0.1,
         10
       )`,
      [
        vectorLiteral(),
        ids.org,
        ids.sourceChannel,
        ids.team,
        ids.currentChannel,
        ids.agent,
      ],
    )

    assert.deepEqual(incompatible.rows, [])

    const compatible = await pool.query<{ id: string }>(
      `SELECT id
       FROM match_thoughts_in_scopes(
         $1::vector,
         'confidential management',
         $2::uuid,
         ARRAY['channel', 'team']::text[],
         ARRAY[$3::uuid, $4::uuid],
         'channel'::"ThoughtAudienceType",
         $3::uuid,
         $5::uuid,
         0.1,
         10
       )`,
      [
        vectorLiteral(),
        ids.org,
        ids.sourceChannel,
        ids.team,
        ids.agent,
      ],
    )

    assert.deepEqual(
      compatible.rows.map((row) => row.id).sort(),
      [ids.teamThought, ids.writtenThought].sort(),
    )
  } finally {
    await pool.query('DELETE FROM organizations WHERE id = $1', [ids.org])
    await pool.query(
      'DELETE FROM users WHERE id = ANY($1::uuid[])',
      [[ids.userA, ids.userB, ids.outsider]],
    )
    await pool.end()
  }
})

import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { Pool } from 'pg'
import { captureThought } from '../src/capture.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

const unavailableModel = {
  chatJson: async () => ({}),
  embed: async () => {
    throw new Error('The PostgreSQL capture regression does not need embeddings')
  },
}

runDatabaseTest(
  'duplicate private capture locks only its Thought and preserves known plus unknown lineage',
  async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL })
    const ids = {
      channel: randomUUID(),
      organization: randomUUID(),
      project: randomUUID(),
      team: randomUUID(),
      user: randomUUID(),
    }
    const content = `private memory lineage canary ${randomUUID()}`

    try {
      await pool.query(
        `INSERT INTO users (id, email, display_name, created_at, updated_at)
         VALUES ($1, $2, 'Source author', now(), now())`,
        [ids.user, `${ids.user}@example.test`],
      )
      await pool.query(
        `INSERT INTO organizations (id, name, created_at, updated_at)
         VALUES ($1, 'Thought lineage capture regression', now(), now())`,
        [ids.organization],
      )
      await pool.query(
        `INSERT INTO organization_members (id, organization_id, user_id, role, created_at)
         VALUES ($1, $2, $3, 'member', now())`,
        [randomUUID(), ids.organization, ids.user],
      )
      await pool.query(
        `INSERT INTO projects (id, name, organization_id, created_at, updated_at)
         VALUES ($1, 'Thought lineage project', $2, now(), now())`,
        [ids.project, ids.organization],
      )
      await pool.query(
        `INSERT INTO teams (id, name, project_id, created_at, updated_at)
         VALUES ($1, 'Thought lineage team', $2, now(), now())`,
        [ids.team, ids.project],
      )
      await pool.query(
        `INSERT INTO channels (
           id, label, slug, type, visibility, organization_id, project_id, team_id, created_at, updated_at
         ) VALUES ($1, 'thought-lineage-private', 'thought-lineage-private', 'standard', 'private', $2, $3, $4, now(), now())`,
        [ids.channel, ids.organization, ids.project, ids.team],
      )

      const capture = (privateConversationSources?: Array<{
        sourceAuthorUserId: string | null
        sourceChannelId: string
      }>) => captureThought({
        audienceId: ids.channel,
        audienceType: 'channel',
        channelId: ids.channel,
        content,
        organizationId: ids.organization,
        ownerId: ids.user,
        ownerType: 'user',
        ...(privateConversationSources === undefined ? {} : { privateConversationSources }),
      }, { modelClient: unavailableModel, pool })

      const legacy = await capture()
      const known = await capture([{
        sourceAuthorUserId: ids.user,
        sourceChannelId: ids.channel,
      }])
      const unproven = await capture([])

      assert.equal(legacy.isDuplicate, false)
      assert.equal(known.isDuplicate, true)
      assert.equal(unproven.isDuplicate, true)
      const sources = await pool.query<{ sourceAuthorUserId: string | null }>(
        `SELECT source_author_user_id AS "sourceAuthorUserId"
         FROM thought_disclosure_sources
         WHERE thought_id = $1::uuid
         ORDER BY source_author_user_id NULLS FIRST`,
        [legacy.id],
      )
      assert.deepEqual(sources.rows, [
        { sourceAuthorUserId: null },
        { sourceAuthorUserId: ids.user },
      ])
    } finally {
      await pool.query('DELETE FROM organizations WHERE id = $1::uuid', [ids.organization])
      await pool.query('DELETE FROM users WHERE id = $1::uuid', [ids.user])
      await pool.end()
    }
  },
)

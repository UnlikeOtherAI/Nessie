import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { Pool } from 'pg'

import {
  persistDeepWaterHandoffReportSources,
  persistDeepWaterHandoffTicket,
} from '../src/deepwater-handoff-runs.js'

const runIfDatabase = process.env.DATABASE_URL ? test : test.skip

runIfDatabase(
  'trusted handoff metadata is idempotent, replaces legacy data, and rejects conflicts',
  async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL })
    const prisma = new PrismaClient()
    const ids = {
      channel: randomUUID(),
      message: randomUUID(),
      organization: randomUUID(),
      project: randomUUID(),
      run: randomUUID(),
      team: randomUUID(),
      thread: randomUUID(),
      usage: randomUUID(),
    }
    const correlationId = `deep-water:${ids.run}`
    const externalRunId = `rs_${ids.run.replaceAll('-', '')}`
    const reportUrl = `https://ledger.example/v1/research/${externalRunId}/report`
    const locator = {
      messageId: ids.message,
      organizationId: ids.organization,
      runId: ids.run,
      teamId: ids.team,
      threadId: ids.thread,
    }

    try {
      await pool.query(
        `INSERT INTO organizations (id, name, created_at, updated_at)
         VALUES ($1, 'Deep Water metadata persistence', now(), now())`,
        [ids.organization],
      )
      await pool.query(
        `INSERT INTO projects (id, name, organization_id, created_at, updated_at)
         VALUES ($1, 'Deep Water metadata persistence', $2, now(), now())`,
        [ids.project, ids.organization],
      )
      await pool.query(
        `INSERT INTO teams (id, name, project_id, created_at, updated_at)
         VALUES ($1, 'Deep Water metadata persistence', $2, now(), now())`,
        [ids.team, ids.project],
      )
      await pool.query(
        `INSERT INTO channels (
           id, label, slug, organization_id, project_id, team_id, created_at, updated_at
         )
         VALUES ($1, 'Deep Water metadata persistence', $2, $3, $4, $5, now(), now())`,
        [
          ids.channel,
          `deep-water-metadata-${ids.channel}`,
          ids.organization,
          ids.project,
          ids.team,
        ],
      )
      await pool.query(
        `INSERT INTO threads (id, channel_id, created_at, updated_at)
         VALUES ($1, $2, now(), now())`,
        [ids.thread, ids.channel],
      )
      await pool.query(
        `INSERT INTO messages (id, thread_id, role, content, created_at)
         VALUES ($1, $2, 'user', 'Deep Water metadata persistence', now())`,
        [ids.message, ids.thread],
      )
      await pool.query(
        `INSERT INTO product_integration_runs (
           id, organization_id, team_id, product_slug, thread_id, message_id,
           status, result_json, created_at, updated_at
         )
         VALUES (
           $1, $2, $3, 'deep-water', $4, $5, 'running',
           '{"startToolCallId":"stable-call"}'::jsonb, now(), now()
         )`,
        [ids.run, ids.organization, ids.team, ids.thread, ids.message],
      )

      const ticket = {
        ...locator,
        externalRunId,
        reportUrl,
        ticketStatus: 'running' as const,
        toolCallId: 'stable-call',
      }
      assert.equal(await persistDeepWaterHandoffTicket(prisma, ticket), true)
      assert.equal(await persistDeepWaterHandoffTicket(prisma, ticket), true)
      assert.equal(await persistDeepWaterHandoffTicket(prisma, {
        ...ticket,
        reportUrl: `https://ledger.example/v1/research/${externalRunId}-conflict/report`,
      }), false)

      await pool.query(
        `UPDATE product_integration_runs
         SET result_json = (result_json - 'reportUrlSource')
           || '{"reportUrl":"https://legacy.invalid/report"}'::jsonb
         WHERE id = $1`,
        [ids.run],
      )
      assert.equal(await persistDeepWaterHandoffTicket(prisma, ticket), true)

      const evidence = {
        ...locator,
        externalRunId,
        sourceCount: 14,
      }
      assert.equal(await persistDeepWaterHandoffReportSources(prisma, evidence), true)
      assert.equal(await persistDeepWaterHandoffReportSources(prisma, evidence), true)
      assert.equal(await persistDeepWaterHandoffReportSources(prisma, {
        ...evidence,
        sourceCount: 15,
      }), false)

      await pool.query(
        `UPDATE product_integration_runs
         SET source_count = 13,
             result_json = result_json - 'sourceCountSource'
         WHERE id = $1`,
        [ids.run],
      )
      const blocker = await pool.connect()
      let blockerCommitted = false
      try {
        await blocker.query('BEGIN')
        await blocker.query(
          'SELECT id FROM product_integration_runs WHERE id = $1 FOR UPDATE',
          [ids.run],
        )
        await blocker.query(
          `INSERT INTO connector_usage_events (
             id, occurred_at, organization_id, team_id, actor_id, correlation_id,
             connector_type, target, operation, calls
           )
           VALUES (
             $1, now(), $2, $3, 'metadata-persistence-test', $4,
             'mcp', 'deep-water', 'research.completed', 1
           )`,
          [ids.usage, ids.organization, ids.team, correlationId],
        )

        const persistence = persistDeepWaterHandoffReportSources(prisma, evidence)
        const state = await Promise.race([
          persistence.then(() => 'settled', () => 'settled'),
          new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 50)),
        ])
        assert.equal(state, 'blocked')
        await blocker.query('COMMIT')
        blockerCommitted = true
        assert.equal(await persistence, true)
      } catch (error) {
        if (!blockerCommitted) await blocker.query('ROLLBACK')
        throw error
      } finally {
        blocker.release()
      }

      const persisted = await pool.query<{
        report_url: string
        report_url_source: string
        source_count: number
        source_count_source: string
        units: number
        unit_type: string
      }>(
        `SELECT
           run.result_json ->> 'reportUrl' AS report_url,
           run.result_json ->> 'reportUrlSource' AS report_url_source,
           run.source_count,
           run.result_json ->> 'sourceCountSource' AS source_count_source,
           usage.units,
           usage.unit_type
         FROM product_integration_runs AS run
         JOIN connector_usage_events AS usage
           ON usage.correlation_id = $2
         WHERE run.id = $1`,
        [ids.run, correlationId],
      )
      assert.deepEqual(persisted.rows, [{
        report_url: reportUrl,
        report_url_source: 'ledger_research_start',
        source_count: 14,
        source_count_source: 'ledger_research_report',
        units: 14,
        unit_type: 'sources',
      }])
    } finally {
      await prisma.$disconnect()
      await pool.query(
        'DELETE FROM connector_usage_events WHERE correlation_id = $1',
        [correlationId],
      )
      await pool.query('DELETE FROM organizations WHERE id = $1', [ids.organization])
      await pool.end()
    }
  },
)

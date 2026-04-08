import type { Pool } from 'pg'
import {
  captureThought,
  searchThoughts,
  logRecalls,
  recordRecallSignal,
  recordOutcome,
  linkThoughts,
  getExperienceStats,
  type CaptureConfig,
  type SearchConfig,
} from '@nessie/memory'

export type ThoughtServiceDeps = {
  pool: Pool
  captureConfig: CaptureConfig
  searchConfig: SearchConfig
}

const buildRecallLookupKey = (thoughtId: string, rankPosition: number): string =>
  `${thoughtId}:${rankPosition}`

export const createThoughtService = (deps: ThoughtServiceDeps) => ({
  capture: (input: Parameters<typeof captureThought>[0]) =>
    captureThought(input, deps.captureConfig),

  search: async (input: Parameters<typeof searchThoughts>[0]) => {
    const client = await deps.pool.connect()

    try {
      await client.query('BEGIN')

      const searchResult = await searchThoughts(input, {
        ...deps.searchConfig,
        pool: client,
      })
      const loggedRecalls = await logRecalls(searchResult.recalls, client)
      const recallIdByResult = new Map<string, string>()

      for (const recall of loggedRecalls) {
        recallIdByResult.set(
          buildRecallLookupKey(recall.thoughtId, recall.rankPosition),
          recall.id,
        )
      }

      await client.query('COMMIT')

      return searchResult.results.map((result) => ({
        ...result,
        recallId: recallIdByResult.get(
          buildRecallLookupKey(result.id, result.rankPosition),
        ),
      }))
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },

  verifyAccess: async (thoughtId: string, organizationId: string) => {
    const result = await deps.pool.query(
      `SELECT id FROM thoughts
       WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
      [thoughtId, organizationId],
    )
    return result.rowCount !== null && result.rowCount > 0
  },

  recordOutcome: (input: Parameters<typeof recordOutcome>[0]) =>
    recordOutcome(input, deps.pool),

  recordRecallSignal: (input: Parameters<typeof recordRecallSignal>[0]) =>
    recordRecallSignal(input, deps.pool),

  link: (input: Parameters<typeof linkThoughts>[0]) =>
    linkThoughts(input, deps.pool),

  experienceStats: (organizationId: string, actorId: string | null) =>
    getExperienceStats(organizationId, actorId, deps.pool),
})

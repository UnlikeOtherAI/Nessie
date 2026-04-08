import type { Pool } from 'pg'
import {
  captureThought,
  searchThoughts,
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

export const createThoughtService = (deps: ThoughtServiceDeps) => ({
  capture: (input: Parameters<typeof captureThought>[0]) =>
    captureThought(input, deps.captureConfig),

  search: (input: Parameters<typeof searchThoughts>[0]) =>
    searchThoughts(input, deps.searchConfig),

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

  link: (input: Parameters<typeof linkThoughts>[0]) =>
    linkThoughts(input, deps.pool),

  experienceStats: (organizationId: string, actorId: string | null) =>
    getExperienceStats(organizationId, actorId, deps.pool),
})

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

  recordOutcome: (input: Parameters<typeof recordOutcome>[0]) =>
    recordOutcome(input, deps.pool),

  link: (input: Parameters<typeof linkThoughts>[0]) =>
    linkThoughts(input, deps.pool),

  experienceStats: (organizationId: string, actorId: string | null) =>
    getExperienceStats(organizationId, actorId, deps.pool),
})

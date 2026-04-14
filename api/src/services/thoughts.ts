import type { Pool } from 'pg'
import type { ThoughtAudienceType } from '@nessie/schemas'
import {
  captureThought,
  searchAndLogThoughts,
  recordRecallSignal,
  recordOutcome,
  linkThoughts,
  getExperienceStats,
  type CaptureConfig,
  type SearchExecutionConfig,
} from '@nessie/memory'

export type ThoughtServiceDeps = {
  pool: Pool
  captureConfig: CaptureConfig
  searchConfig: SearchExecutionConfig
}

type VerifyThoughtAccessInput = {
  thoughtId: string
  organizationId: string
  requesterUserId: string
  outputAudienceType: ThoughtAudienceType
  outputAudienceId: string
}

export const createThoughtService = (deps: ThoughtServiceDeps) => ({
  capture: (input: Parameters<typeof captureThought>[0]) =>
    captureThought(input, deps.captureConfig),

  search: (input: Parameters<typeof searchAndLogThoughts>[0]) =>
    searchAndLogThoughts(input, deps.searchConfig),

  verifyAccess: async (input: VerifyThoughtAccessInput) => {
    const result = await deps.pool.query(
      `SELECT t.id
       FROM thoughts AS t
       WHERE t.id = $1
         AND t.organization_id = $2
         AND t.deleted_at IS NULL
         AND thought_requester_has_access(
           $3::uuid,
           $4::"ThoughtAudienceType",
           $5::uuid,
           t.organization_id
         )
         AND thought_requester_has_access(
           $3::uuid,
           resolve_thought_audience_type(
             t.audience_type,
             t.visibility,
             t.owner_type,
             t.owner_id,
             t.user_id
           ),
           resolve_thought_audience_id(
             t.audience_id,
             resolve_thought_audience_type(
               t.audience_type,
               t.visibility,
               t.owner_type,
               t.owner_id,
               t.user_id
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
         AND thought_audience_compatible_with_output(
           resolve_thought_audience_type(
             t.audience_type,
             t.visibility,
             t.owner_type,
             t.owner_id,
             t.user_id
           ),
           resolve_thought_audience_id(
             t.audience_id,
             resolve_thought_audience_type(
               t.audience_type,
               t.visibility,
               t.owner_type,
               t.owner_id,
               t.user_id
             ),
             t.organization_id,
             t.project_id,
             t.team_id,
             t.channel_id,
             t.user_id,
             t.owner_type,
             t.owner_id
           ),
           $4::"ThoughtAudienceType",
           $5::uuid,
           t.organization_id
         )`,
      [
        input.thoughtId,
        input.organizationId,
        input.requesterUserId,
        input.outputAudienceType,
        input.outputAudienceId,
      ],
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

import { Prisma } from '@prisma/client'
import {
  DeepWaterDisclosureSourcesSchema,
  DeepWaterSourceScopesSchema,
  isDelegatedSystemDmChannelType,
  type DeepWaterDisclosureSource,
  type DeepWaterSourceScope,
} from '@nessie/schemas'

import {
  lockDeepWaterBriefRun,
  type DeepWaterBriefDb,
  type DeepWaterBriefRun,
} from './deepwater-brief-run-record.js'

/**
 * What a DeepWater research was built from (Water plan amendments N6), kept on
 * its product run as two portable, never destination-subtracted columns in the
 * shape `versionDisclosureFromConsumedSources` writes: `source_scopes` (basis
 * scopes) and `disclosure_sources` (private-conversation lineage).
 *
 * Both only grow. The research carries everything any content-bearing call fed
 * it, so a later read or delivery can never disclose it more widely than the
 * least-shared source it was built from.
 */

export type DeepWaterRunSources = {
  sourceScopes: DeepWaterSourceScope[]
  disclosureSources: DeepWaterDisclosureSource[]
}

/**
 * The sources a person's brief starts with (N6): the words they type in a room
 * that is not public — a private or protected channel, or their Personal
 * Assistant DM — are that room's, so the research carries the room's channel
 * scope and the person's own lineage there. A public room seeds nothing. The
 * rule the run prompt applies to human text in a non-public room
 * (`worker/src/run/execute/prompt.ts`).
 */
export const deepWaterPersonOriginSources = (input: {
  channelId: string
  channelVisibility: string
  systemChannelType: string | null
  requesterUserId: string
}): DeepWaterRunSources => {
  const nonPublic = input.channelVisibility !== 'public' || isDelegatedSystemDmChannelType(input.systemChannelType)
  if (!nonPublic) return { sourceScopes: [], disclosureSources: [] }
  return {
    sourceScopes: [{ scopeType: 'channel', scopeId: input.channelId }],
    disclosureSources: [{ sourceChannelId: input.channelId, sourceAuthorUserId: input.requesterUserId }],
  }
}

const scopeKey = (scope: DeepWaterSourceScope): string => JSON.stringify([scope.scopeType, scope.scopeId])

/**
 * A null author is kept apart from every known one: it records words whose
 * author is unknown, which no known author's consent can cover.
 */
const sourceKey = (source: DeepWaterDisclosureSource): string =>
  JSON.stringify([source.sourceChannelId, source.sourceAuthorUserId])

const union = <T>(current: readonly T[], incoming: readonly T[], key: (value: T) => string): T[] => {
  const seen = new Set(current.map(key))
  const added = incoming.filter((value) => {
    const k = key(value)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  return [...current, ...added]
}

export type DeepWaterSourcesUnion = {
  run: DeepWaterBriefRun
  /** At least one scope or source was new to the run. */
  grew: boolean
}

/**
 * Add a content-bearing call's sources to the run, under its row lock (N6): an
 * agent's `research_scope_start`, `research_scope_reply`, or
 * `research_scope_launch` with edits unions its run's whole consumed-source
 * sink here. Monotone: existing entries are never removed or reordered, so
 * concurrent calls converge on the union of everything either fed it. Null
 * when the run is not a deep-water run of this organisation.
 */
export const unionDeepWaterRunSources = async (
  tx: DeepWaterBriefDb,
  input: { organizationId: string; runId: string } & DeepWaterRunSources,
): Promise<DeepWaterSourcesUnion | null> => {
  const locked = await lockDeepWaterBriefRun(tx, input)
  if (!locked) return null
  const { run } = locked
  const incomingScopes = DeepWaterSourceScopesSchema.parse(input.sourceScopes)
  const incomingSources = DeepWaterDisclosureSourcesSchema.parse(input.disclosureSources)
  const sourceScopes = union(run.sourceScopes, incomingScopes, scopeKey)
  const disclosureSources = union(run.disclosureSources, incomingSources, sourceKey)
  const grew = sourceScopes.length > run.sourceScopes.length
    || disclosureSources.length > run.disclosureSources.length
  if (!grew) return { run, grew: false }

  await tx.$executeRaw(Prisma.sql`
    UPDATE "product_integration_runs"
    SET "source_scopes" = CAST(${JSON.stringify(sourceScopes)} AS jsonb),
        "disclosure_sources" = CAST(${JSON.stringify(disclosureSources)} AS jsonb),
        "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = CAST(${run.id} AS uuid)
  `)
  return { run: { ...run, sourceScopes, disclosureSources }, grew: true }
}

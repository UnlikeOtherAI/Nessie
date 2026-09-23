import {
  constrainScopesToDestination,
  constrainScopesToProjectWrite,
  isWithinProjectWriteScopes,
  loadThoughtDisclosureLineage,
  resolveAccessibleScopes,
  searchAndLogThoughtsInScopes,
  type RetainSearchResults,
  type ScopeRef,
  type ScopeResolutionMode,
  type SearchResult,
  type ThoughtDisclosureLineage,
} from '@nessie/memory'
import type { RunExecuteJobPayload } from '@nessie/schemas'
import { resolveLiveEntitlements, type LiveEntitlements } from '@nessie/runtime'
import {
  agentActsAsRequestingPerson,
  runDelegatesToRequestingPerson,
  type DelegatedRunFacts,
} from '../delegated-identity.js'
import type { ExecutionDependencies, RetrievedMemory, RunContext } from './types.js'
import { markUnknownPrivateConversationScopes } from './private-conversation-lineage.js'
import type { ConsumedSourceSink } from './disclosure-basis.js'
import type { PrismaClient } from '@prisma/client'

const MAX_MEMORY_RESULTS = 5
const MAX_MEMORY_CONTEXT_LENGTH = 220

/**
 * How many times its normal depth a project-write recall searches.
 *
 * Project-write containment judges each recalled item's whole lineage after
 * the search, so a search that asked for only the normal count came back
 * short — or empty — whenever the requester's best matches had been fed by a
 * private DM, while project knowledge sat just below the cut. Such a run
 * searches this many times deeper and keeps at most the normal count of what
 * survives. A fixed multiple, so the search stays bounded; every other run
 * searches exactly as deep as before.
 */
export const PROJECT_WRITE_RECALL_DEPTH = 3

const CONTAINMENT_DISABLED = new Set(['0', 'false', 'off', 'no'])

/**
 * Recall containment is ON by default. It is the safe floor the full disclosure
 * boundary is built behind, so disabling it is an explicit deployment act and
 * should only happen once that boundary ships.
 */
export const isContainmentEnabled = (
  env: NodeJS.ProcessEnv = process.env,
): boolean =>
  !CONTAINMENT_DISABLED.has(
    (env['NESSIE_DISCLOSURE_CONTAINMENT'] ?? '').trim().toLowerCase(),
  )

/**
 * Delegate identity decides whose accessible scopes are considered; the
 * DESTINATION decides whether those scopes must be contained.
 *
 * The exemption keys on the surface and never on the agent kind — the scopes
 * doc is explicit about this, and a shared PA presence is exactly why: it
 * carries the owner's identity into a room full of other people. The exempt
 * surfaces are the single-member private homes: the PA's own DM and a DM-homed
 * global agent's own home DM. Both hold exactly one human — enforced by the
 * deferred `channel_members` trigger — so "the destination already implies this
 * person's private estate" is true there and nowhere else.
 */
export const requiresMemoryDestinationContainment = (
  facts: DelegatedRunFacts,
  containmentEnabled = isContainmentEnabled(),
): boolean =>
  containmentEnabled && !runDelegatesToRequestingPerson(facts)

const truncateForContext = (value: string, maxLength: number): string =>
  value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`

const LEADING_SECTION_TAG_REGEX = /^\s*\[[A-Za-z][A-Za-z\s/-]{0,24}\]\s*/

export const stripLeadingSectionTag = (text: string): string =>
  text.replace(LEADING_SECTION_TAG_REGEX, '')

export const buildMemoryContext = (memories: RetrievedMemory[]): string | null => {
  if (memories.length === 0) {
    return null
  }

  const lines = memories.map(
    (memory, index) =>
      `${index + 1}. ${truncateForContext(memory.content.trim(), MAX_MEMORY_CONTEXT_LENGTH)}`,
  )

  return ['Relevant long-term memories:', ...lines].join('\n')
}

const isSuppressedMemory = (metadata: unknown): boolean => {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return false
  }

  const record = metadata as Record<string, unknown>
  return record['suppressed'] === true || record['suppressionState'] === 'suppressed'
}

/** Add each recalled Thought's stored authors without letting another Thought mask a legacy gap. */
export const admitRememberedThoughtLineage = async (
  prisma: PrismaClient,
  sink: ConsumedSourceSink,
  lineages: readonly ThoughtDisclosureLineage[],
): Promise<void> => {
  const unrepresentedAudiences = []
  for (const lineage of lineages) {
    if (lineage.audienceId && lineage.audienceType) {
      sink.add({ scopeId: lineage.audienceId, scopeType: lineage.audienceType })
    }
    for (const source of lineage.sources) sink.addPrivateConversationSource(source)
    if (
      lineage.audienceType === 'channel'
      && lineage.audienceId
      && !lineage.sources.some((source) => source.sourceChannelId === lineage.audienceId)
    ) {
      unrepresentedAudiences.push({ scopeId: lineage.audienceId, scopeType: lineage.audienceType })
    }
  }
  await markUnknownPrivateConversationScopes(prisma, sink, unrepresentedAudiences)
}

/**
 * Every scope a recalled thought brings into the run: its audience, and each
 * private conversation it was captured from, which the sink records as that
 * conversation's channel scope.
 */
export const thoughtLineageScopes = (lineage: ThoughtDisclosureLineage): ScopeRef[] => [
  ...(lineage.audienceId && lineage.audienceType
    ? [{ scopeId: lineage.audienceId, scopeType: lineage.audienceType }]
    : []),
  ...lineage.sources.map((source) => ({ scopeId: source.sourceChannelId, scopeType: 'channel' })),
]

/**
 * A contained run that holds project-delegated write tools recalls only what
 * every project reader already has (`constrainScopesToProjectWrite`).
 *
 * The project write gate refuses a run holding any channel, team or user
 * source, so a memory the requester's private DM fed — admitted because its
 * audience is the organisation — used to shut every ticket write for the rest
 * of the run, silently. Narrowing recall for exactly these runs keeps the gate
 * as it is: the run simply does not remember that material. A run without
 * write tools, and a delegate in its own home, recall as they always did.
 */
export const requiresProjectWriteRecallContainment = (
  facts: DelegatedRunFacts,
  holdsProjectWriteTools: boolean,
  containmentEnabled = isContainmentEnabled(),
): boolean =>
  holdsProjectWriteTools && requiresMemoryDestinationContainment(facts, containmentEnabled)

/**
 * A thought that vanished after search has no durable provenance to admit.
 * Exclude it before it reaches model context rather than treating the missing
 * row as an unrestricted memory.
 */
export const retainThoughtsWithLineage = <T extends { id: string }>(
  results: readonly T[],
  lineages: readonly ThoughtDisclosureLineage[],
): T[] => {
  const lineageIds = new Set(
    lineages
      .filter((lineage) => lineage.audienceId !== null && lineage.audienceType !== null)
      .map((lineage) => lineage.thoughtId),
  )
  return results.filter((result) => lineageIds.has(result.id))
}

export const retrieveRelevantMemories = async (
  deps: ExecutionDependencies,
  context: RunContext,
  payload: RunExecuteJobPayload,
  prompt: string,
  liveEntitlements?: LiveEntitlements,
  /** Whether the run was lent a project-delegated tool that writes. */
  options: { holdsProjectWriteTools?: boolean } = {},
): Promise<SearchResult[]> => {
  const effectiveUserId =
    payload.actorContext.actionContext.effectiveUserId
    ?? (payload.actorContext.actor.actorType === 'user'
      ? payload.actorContext.actor.actorId
      : undefined)

  const delegationFacts: DelegatedRunFacts = {
    agentKind: context.agent.agentKind,
    dmKey: context.channel.dmKey,
    organizationId: context.channel.organizationId,
    systemChannelType: context.channel.systemChannelType,
    systemSlug: context.agent.systemSlug,
  }

  // Scope resolution follows delegate identity everywhere it acts — the PA, or
  // a DM-homed global agent. The containment exemption below is narrower: only
  // the delegate's own single-member home implies that person's private estate.
  // A delegate acts as its person, so it recalls everything that person can;
  // without a person there is nothing to act as.
  const actsAsPerson =
    agentActsAsRequestingPerson(delegationFacts)
    // A delegated system DM is that person's surface whatever kind of agent is
    // answering in it, which is the fact the destination arm has always
    // carried; keep it so a home DM never silently drops to `autonomous`.
    || runDelegatesToRequestingPerson(delegationFacts)
  if (actsAsPerson && !effectiveUserId) {
    return []
  }

  const mode: ScopeResolutionMode = actsAsPerson
    ? 'personal_assistant'
    : effectiveUserId
      ? 'user_shared'
      : 'autonomous'

  try {
    const entitlements = effectiveUserId
      ? liveEntitlements ?? await resolveLiveEntitlements(deps.prisma, {
        organizationId: context.channel.organizationId,
        uoaIdentity: payload.actorContext.actionContext.uoaIdentity,
        userId: effectiveUserId,
      })
      : undefined
    const reachableScopes = await resolveAccessibleScopes(
      {
        agentId: context.agent.id,
        entitlements,
        mode,
        organizationId: context.channel.organizationId,
        userId: effectiveUserId ?? null,
      },
      deps.searchConfig.pool,
    )

    // Containment (default on): a shared or autonomous run recalls only what the
    // destination room's own scope chain already implies, so cross-scope material
    // never enters the run — and therefore cannot reach the transcript, the
    // realtime wire, consolidated memory, or any artifact derived from the run.
    // A delegate in its own home is exempt: it acts as that person, in a DM
    // whose only human is that person, and their private memories are the point.
    // See docs/plans/2026-08-11-disclosure-boundaries-build.md.
    const destination = {
      channelId: context.channel.id,
      organizationId: context.channel.organizationId,
      projectId: context.channel.projectId,
      teamId: context.channel.teamId,
    }
    const projectWrite = requiresProjectWriteRecallContainment(
      delegationFacts,
      options.holdsProjectWriteTools === true,
    )
    const scopes = projectWrite
      ? constrainScopesToProjectWrite(reachableScopes, destination)
      : requiresMemoryDestinationContainment(delegationFacts)
        ? constrainScopesToDestination(reachableScopes, destination)
        : reachableScopes

    if (scopes.audienceTypes.length === 0) {
      return []
    }

    // The thoughts this run takes, in rank order, and the lineage each brings.
    // The search already narrowed the audience; a thought captured from a
    // private conversation still carries that conversation, so a
    // project-write run judges the whole lineage before admitting it.
    let takenLineages: ThoughtDisclosureLineage[] = []
    const take: RetainSearchResults = async (found, db) => {
      const retained = found.filter((result) => !isSuppressedMemory(result.metadata))
      if (retained.length === 0) return retained
      const loaded = await loadThoughtDisclosureLineage(db, retained.map((result) => result.id))
      const lineages = projectWrite
        ? loaded.filter((lineage) =>
          isWithinProjectWriteScopes(thoughtLineageScopes(lineage), destination))
        : loaded
      // In rank order, so a deeper project-write search still hands the model
      // no more than the normal count, and only those enter the basis.
      const taken = retainThoughtsWithLineage(retained, lineages).slice(0, MAX_MEMORY_RESULTS)
      const takenIds = new Set(taken.map((result) => result.id))
      takenLineages = lineages.filter((lineage) => takenIds.has(lineage.thoughtId))
      return taken
    }

    const results = await searchAndLogThoughtsInScopes(
      {
        audienceIds: scopes.audienceIds,
        audienceTypes: scopes.audienceTypes,
        channelId: context.channel.id,
        includeReasoning: false,
        limit: projectWrite ? MAX_MEMORY_RESULTS * PROJECT_WRITE_RECALL_DEPTH : MAX_MEMORY_RESULTS,
        organizationId: context.channel.organizationId,
        projectId: payload.actorContext.tenant.projectId ?? null,
        query: prompt,
        runningAgentId: context.agent.id,
        sessionId: payload.actorContext.actionContext.sessionId,
        teamId:
          payload.actorContext.tenant.teamId
          ?? payload.actorContext.actionContext.teamId
          ?? null,
        threadId: context.run.threadId,
        taskId: context.task.id,
        runId: context.run.id,
        agentId: context.agent.id,
        agentKind: context.agent.agentKind,
        actorId: payload.actorContext.actor.actorId,
        actorType: payload.actorContext.actor.actorType,
        requestId: payload.actorContext.actionContext.requestId,
        correlationId: payload.actorContext.actionContext.correlationId ?? null,
        uoaIdentity: payload.actorContext.actionContext.uoaIdentity,
        userId: effectiveUserId ?? null,
      },
      deps.searchConfig,
      // A project-write search goes deeper than it keeps, so only what it
      // keeps is marked accessed and logged as recalled. Access feeds the
      // recency term of every later ranking: bumping the DM-fed thoughts it
      // refused would keep lifting exactly those above the project knowledge
      // it came for. Every other run's bookkeeping is unchanged.
      projectWrite ? take : undefined,
    )
    const memories = projectWrite ? results : await take(results, deps.searchConfig.pool)

    // Record what this run actually consumed. The basis of anything the run
    // later materialises is computed from this sink, so a memory that reached
    // the model is provenance even if the model never quotes it.
    await admitRememberedThoughtLineage(deps.prisma, context.consumedSources, takenLineages)
    return memories
  } catch (error) {
    console.warn(
      '[worker] Memory search failed, continuing without memories:',
      error instanceof Error ? error.message : error,
    )
    return []
  }
}

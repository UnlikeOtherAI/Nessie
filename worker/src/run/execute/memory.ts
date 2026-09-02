import {
  constrainScopesToDestination,
  loadThoughtAudiences,
  resolveAccessibleScopes,
  searchAndLogThoughtsInScopes,
  type ScopeResolutionMode,
  type SearchResult,
} from '@nessie/memory'
import type { RunExecuteJobPayload } from '@nessie/schemas'
import {
  agentActsAsRequestingPerson,
  runDelegatesToRequestingPerson,
  type DelegatedRunFacts,
} from '../delegated-identity.js'
import type { ExecutionDependencies, RetrievedMemory, RunContext } from './types.js'

const MAX_MEMORY_RESULTS = 5
const MAX_MEMORY_CONTEXT_LENGTH = 220
const MIN_REFERENCE_TOKENS = 5

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

const normalizeForReferenceMatch = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const buildReferencePhrases = (content: string): string[] => {
  const normalizedContent = normalizeForReferenceMatch(content)
  if (!normalizedContent) {
    return []
  }

  const phrases = new Set<string>()
  const sentenceCandidates = content
    .split(/[\n.!?;]+/)
    .map((part) => normalizeForReferenceMatch(part))
    .filter((part) => part.length >= 20)

  for (const phrase of sentenceCandidates.slice(0, 6)) {
    phrases.add(phrase)
  }

  const tokens = normalizedContent.split(' ').filter(Boolean)
  if (tokens.length < MIN_REFERENCE_TOKENS) {
    phrases.add(normalizedContent)
    return [...phrases]
  }

  const maxWindows = Math.min(tokens.length - MIN_REFERENCE_TOKENS + 1, 8)
  for (let index = 0; index < maxWindows; index += 1) {
    phrases.add(tokens.slice(index, index + MIN_REFERENCE_TOKENS).join(' '))
  }

  return [...phrases]
}

const isMemoryReferenced = (
  responseText: string,
  memoryContent: string,
): boolean => {
  const normalizedResponse = normalizeForReferenceMatch(responseText)
  if (!normalizedResponse) {
    return false
  }

  return buildReferencePhrases(memoryContent).some(
    (phrase) => phrase.length > 0 && normalizedResponse.includes(phrase),
  )
}

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

export const detectReferencedRecallIds = (
  responseText: string,
  memories: RetrievedMemory[],
): string[] =>
  memories.flatMap((memory) =>
    memory.recallId && isMemoryReferenced(responseText, memory.content)
      ? [memory.recallId]
      : [],
  )

const isSuppressedMemory = (metadata: unknown): boolean => {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return false
  }

  const record = metadata as Record<string, unknown>
  return record['suppressed'] === true || record['suppressionState'] === 'suppressed'
}

export const retrieveRelevantMemories = async (
  deps: ExecutionDependencies,
  context: RunContext,
  payload: RunExecuteJobPayload,
  prompt: string,
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
    const reachableScopes = await resolveAccessibleScopes(
      {
        agentId: context.agent.id,
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
    const scopes =
      requiresMemoryDestinationContainment(delegationFacts)
        ? constrainScopesToDestination(reachableScopes, {
          channelId: context.channel.id,
          organizationId: context.channel.organizationId,
          projectId: context.channel.projectId,
          teamId: context.channel.teamId,
        })
        : reachableScopes

    if (scopes.audienceTypes.length === 0) {
      return []
    }

    const results = await searchAndLogThoughtsInScopes(
      {
        audienceIds: scopes.audienceIds,
        audienceTypes: scopes.audienceTypes,
        channelId: context.channel.id,
        includeReasoning: false,
        limit: MAX_MEMORY_RESULTS,
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
        userId: effectiveUserId ?? null,
      },
      deps.searchConfig,
    )

    const retained = results.filter((result) => !isSuppressedMemory(result.metadata))

    // Record what this run actually consumed. The basis of anything the run
    // later materialises is computed from this sink, so a memory that reached
    // the model is provenance even if the model never quotes it.
    if (retained.length > 0) {
      const audiences = await loadThoughtAudiences(
        deps.searchConfig.pool,
        retained.map((result) => result.id),
      )
      context.consumedSources.addAll(audiences)
    }

    return retained
  } catch (error) {
    console.warn(
      '[worker] Memory search failed, continuing without memories:',
      error instanceof Error ? error.message : error,
    )
    return []
  }
}

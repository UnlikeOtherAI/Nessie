import {
  resolveAccessibleScopes,
  searchAndLogThoughtsInScopes,
  type ScopeResolutionMode,
  type SearchResult,
} from '@nessie/memory'
import type { RunExecuteJobPayload } from '@nessie/schemas'
import type { ExecutionDependencies, RetrievedMemory, RunContext } from './types.js'

const MAX_MEMORY_RESULTS = 5
const MAX_MEMORY_CONTEXT_LENGTH = 220
const MIN_REFERENCE_TOKENS = 5

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

  const isPersonalAssistant =
    context.channel.systemChannelType === 'personal_assistant'
    || context.agent.agentKind === 'personal_assistant'

  // The personal assistant acts as its owner, so it recalls everything that
  // user can; without a user there is nothing to act as.
  if (isPersonalAssistant && !effectiveUserId) {
    return []
  }

  const mode: ScopeResolutionMode = isPersonalAssistant
    ? 'personal_assistant'
    : effectiveUserId
      ? 'user_shared'
      : 'autonomous'

  try {
    const scopes = await resolveAccessibleScopes(
      {
        agentId: context.agent.id,
        mode,
        organizationId: context.channel.organizationId,
        userId: effectiveUserId ?? null,
      },
      deps.searchConfig.pool,
    )

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
        query: prompt,
        runningAgentId: context.agent.id,
        sessionId: payload.actorContext.actionContext.sessionId,
        userId: effectiveUserId ?? null,
      },
      deps.searchConfig,
    )

    return results.filter((result) => !isSuppressedMemory(result.metadata))
  } catch (error) {
    console.warn(
      '[worker] Memory search failed, continuing without memories:',
      error instanceof Error ? error.message : error,
    )
    return []
  }
}

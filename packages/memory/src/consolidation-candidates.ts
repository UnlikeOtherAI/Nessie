import { MemoryConsolidationExtractionSchema } from '@nessie/schemas'

import type { ThoughtMemoryCategory } from './capture.js'
import type { PrivateConversationSource } from './disclosure-sources.js'

export const MAX_CONSOLIDATION_CANDIDATES = 4
export const MAX_CONSOLIDATION_MESSAGE_CHARS = 2_000

export type ConsolidationExtractionMessage = {
  content: string
  id: string
  role: 'assistant' | 'user'
}

export type ConsolidationExtractionInput = {
  messages: ConsolidationExtractionMessage[]
}

export type ConsolidationCandidateExtractor = (
  input: ConsolidationExtractionInput,
) => Promise<unknown>

export type ExtractedConsolidationCandidate = {
  content: string
  importance: number
  memoryCategory: ThoughtMemoryCategory
  privateConversationSources: PrivateConversationSource[]
  sourceMessageIds: string[]
}

type SourceMessage = {
  content: string
  id: string
  privateConversationSources?: PrivateConversationSource[]
  role: string
}

const collapseWhitespace = (value: string): string => value.replace(/\s+/gu, ' ').trim()

const truncateForInference = (value: string): string => {
  const collapsed = collapseWhitespace(value)
  return collapsed.length <= MAX_CONSOLIDATION_MESSAGE_CHARS
    ? collapsed
    : collapsed.slice(0, MAX_CONSOLIDATION_MESSAGE_CHARS)
}

const sourceKey = (source: PrivateConversationSource): string =>
  `${source.sourceChannelId}\u0000${source.sourceAuthorUserId ?? ''}`

const sourcesFor = (messages: SourceMessage[]): PrivateConversationSource[] => {
  const sources = new Map<string, PrivateConversationSource>()
  for (const message of messages) {
    for (const source of message.privateConversationSources ?? []) {
      sources.set(sourceKey(source), source)
    }
  }
  return [...sources.values()]
}

/**
 * Validate model-authored meaning while keeping scope and lineage deterministic.
 * The extractor sees only the bounded, disclosure-safe tail supplied here;
 * every cited id must resolve back to that exact input.
 */
export const extractConsolidationCandidates = async (
  input: {
    extract: ConsolidationCandidateExtractor
    messages: SourceMessage[]
  },
): Promise<ExtractedConsolidationCandidate[]> => {
  const eligible = input.messages.filter(
    (message): message is SourceMessage & { role: 'assistant' | 'user' } =>
      message.role === 'assistant' || message.role === 'user',
  )
  if (eligible.length === 0) return []

  const extractionInput: ConsolidationExtractionInput = {
    messages: eligible.map((message) => ({
      content: truncateForInference(message.content),
      id: message.id,
      role: message.role,
    })),
  }
  const parsed = MemoryConsolidationExtractionSchema.parse(
    await input.extract(extractionInput),
  )
  const messagesById = new Map(eligible.map((message) => [message.id, message]))
  const inferenceSources = sourcesFor(eligible)

  return parsed.candidates.map((candidate) => {
    for (const id of candidate.sourceMessageIds) {
      if (!messagesById.has(id)) {
        throw new Error(`Memory extraction cited unavailable source message ${id}`)
      }
    }
    return {
      ...candidate,
      content: collapseWhitespace(candidate.content).normalize('NFC'),
      // The model read the full tail. Citations aid traceability but cannot
      // narrow the authorization basis of a synthesis over that input.
      privateConversationSources: inferenceSources,
    }
  })
}

/** NFKC keeps Unicode letters while folding canonically equivalent spellings. */
export const normalizeConsolidationCandidateKey = (content: string): string =>
  collapseWhitespace(content).normalize('NFKC').toLowerCase()

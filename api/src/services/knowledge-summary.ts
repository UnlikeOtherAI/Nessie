import type { KnowledgeSearchHit } from '@nessie/knowledge'
import type { LedgerAttribution, ModelClient, ModelMessage } from '@nessie/runtime'
import { z } from 'zod'

// Bounded, cited synthesis over the top hybrid-search chunks for the opt-in
// `search.summary` endpoint. Kept dependency-free of Fastify so it can be
// unit-tested without spinning up HTTP.

export const MAX_SUMMARY_CHUNKS = 8
export const MAX_SUMMARY_CHARS = 6000
export const MAX_QUOTE_CHARS = 200
export const SUMMARY_MAX_TOKENS = 600
export const SUMMARY_TEMPERATURE = 0.2

export type SummaryPassage = {
  pageId: string
  title: string
  spaceId: string
  content: string
}

export type SummaryCitation = {
  pageId: string
  quote: string
}

// Selects the passages to feed the model: at most MAX_SUMMARY_CHUNKS chunks
// across all hits, capped at ~MAX_SUMMARY_CHARS combined characters. Hits and
// their passages arrive pre-ranked by relevance, so this greedily takes them
// in order and stops at the first passage that would blow the char budget —
// whole passages are kept or dropped, never truncated mid-passage. Hits
// without passages (e.g. a keyword-only provider) fall back to their snippet
// as a single chunk.
export const buildSummaryPassages = (hits: KnowledgeSearchHit[]): SummaryPassage[] => {
  const passages: SummaryPassage[] = []
  let totalChars = 0

  for (const hit of hits) {
    const hitPassages = hit.passages && hit.passages.length > 0
      ? hit.passages
      : [{ content: hit.snippet, startOffset: 0, endOffset: hit.snippet.length, score: hit.score ?? 0 }]

    for (const passage of hitPassages) {
      const content = passage.content.trim()
      if (!content) continue
      if (passages.length >= MAX_SUMMARY_CHUNKS) return passages
      if (totalChars + content.length > MAX_SUMMARY_CHARS) return passages
      passages.push({
        pageId: hit.page.id,
        title: hit.page.title,
        spaceId: hit.page.spaceId,
        content,
      })
      totalChars += content.length
    }
  }

  return passages
}

const SUMMARY_SYSTEM_INSTRUCTION = [
  'You answer questions using ONLY the numbered passages supplied by the user.',
  'Do not use outside knowledge. If the passages do not contain enough information',
  'to answer the question, say so plainly instead of guessing.',
  'Respond with a single JSON object shaped exactly like:',
  '{"answer": string, "citations": [{"pageId": string, "quote": string}]}.',
  'Each citation\'s pageId must be copied verbatim from a passage header',
  '(the value after "pageId=") and its quote must be a short verbatim span',
  '(200 characters or fewer) taken from that same passage.',
].join(' ')

const RETRY_ADDENDUM = 'Your previous reply was not valid JSON. Return only valid JSON matching the required shape — no prose, no markdown fences.'

export const buildSummaryMessages = (
  query: string,
  passages: SummaryPassage[],
): ModelMessage[] => {
  const numbered = passages
    .map((passage, index) => `[${index + 1}] pageId=${passage.pageId} title=${passage.title}\n${passage.content}`)
    .join('\n\n')

  return [
    { role: 'system', content: SUMMARY_SYSTEM_INSTRUCTION },
    { role: 'user', content: `Question: ${query}\n\nPassages:\n${numbered}` },
  ]
}

const ModelOutputSchema = z.object({
  answer: z.string().trim().min(1),
  citations: z.array(z.object({
    pageId: z.string().min(1),
    quote: z.string().trim().min(1).max(MAX_QUOTE_CHARS),
  })).max(MAX_SUMMARY_CHUNKS),
})

export type ValidatedSummary = {
  answer: string
  citations: SummaryCitation[]
}

// Validates the model's raw JSON output against the required shape, then
// drops (rather than rejects the whole response for) any citation whose
// pageId is not among the passages we actually supplied — the model
// hallucinating an id is not grounds to fail the request. Returns null when
// the top-level shape itself is unparseable/invalid, signalling the caller to
// retry.
export const validateModelOutput = (
  raw: unknown,
  allowedPageIds: ReadonlySet<string>,
): ValidatedSummary | null => {
  const parsed = ModelOutputSchema.safeParse(raw)
  if (!parsed.success) return null
  const citations = parsed.data.citations
    .filter((citation) => allowedPageIds.has(citation.pageId))
    .slice(0, MAX_SUMMARY_CHUNKS)
  return { answer: parsed.data.answer, citations }
}

export type SynthesizeSummaryInput = {
  modelClient: ModelClient
  query: string
  passages: SummaryPassage[]
  usage: LedgerAttribution
}

// Runs the single synthesis call, retrying once with a terse addendum if the
// model's JSON is unparseable or does not match the required shape. Returns
// null when both attempts fail, so the route can respond 502
// MODEL_OUTPUT_INVALID.
export const synthesizeSummary = async (
  input: SynthesizeSummaryInput,
): Promise<ValidatedSummary | null> => {
  const { modelClient, query, passages, usage } = input
  const allowedPageIds = new Set(passages.map((passage) => passage.pageId))
  const baseMessages = buildSummaryMessages(query, passages)

  const attempt = async (messages: ModelMessage[]): Promise<ValidatedSummary | null> => {
    let raw: unknown
    try {
      raw = await modelClient.chatJson<unknown>(messages, {
        maxTokens: SUMMARY_MAX_TOKENS,
        temperature: SUMMARY_TEMPERATURE,
        usage,
      })
    } catch {
      return null
    }
    return validateModelOutput(raw, allowedPageIds)
  }

  const first = await attempt(baseMessages)
  if (first) return first

  const retryMessages: ModelMessage[] = [
    ...baseMessages,
    { role: 'user', content: RETRY_ADDENDUM },
  ]
  return attempt(retryMessages)
}

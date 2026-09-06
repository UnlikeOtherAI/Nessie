import {
  WEB_SEARCH_CARD_MAX_RELATED,
  WEB_SEARCH_CARD_MAX_RESULTS,
  WEB_SEARCH_CARD_SCHEMA_VERSION,
  WebSearchCardSchema,
  type WebSearchCard,
} from '@nessie/schemas'
import type { WebSearchOutput } from './web-search.js'

/**
 * Turn a search the tool just ran into the card payload a message carries.
 *
 * The card is built here, from the provider response, and never from anything
 * the model wrote: the whole value of a source list is that its links are the
 * ones the engine returned.
 */

const SNIPPET_PREVIEW_CHARS = 200

const clip = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`

export const toWebSearchCard = (output: WebSearchOutput): WebSearchCard =>
  WebSearchCardSchema.parse({
    schemaVersion: WEB_SEARCH_CARD_SCHEMA_VERSION,
    provider: output.provider,
    query: output.query,
    page: output.page,
    count: output.count,
    ...(output.answer ? { answer: clip(output.answer, 2000) } : {}),
    ...(output.answerSource ? { answerSource: output.answerSource } : {}),
    ...(output.knowledgePanel ? { knowledgePanel: output.knowledgePanel } : {}),
    results: output.results.slice(0, WEB_SEARCH_CARD_MAX_RESULTS).map((result) => ({
      position: result.position,
      title: clip(result.title, 300),
      url: result.url,
      ...(result.snippet ? { snippet: clip(result.snippet, 1000) } : {}),
      ...(result.date ? { date: clip(result.date, 60) } : {}),
      ...(result.source ? { source: clip(result.source, 200) } : {}),
    })),
    ...(output.related.length > 0
      ? { related: output.related.slice(0, WEB_SEARCH_CARD_MAX_RELATED) }
      : {}),
    hasMore: output.hasMore,
  })

/**
 * What the card's message *says* when nothing renders it — the agent's own
 * transcript, message search, a notification, an export. The card is a message
 * like any other, so it has to read as one.
 */
export const renderWebSearchCardPlainText = (card: WebSearchCard): string => {
  const lines = [
    card.page > 1
      ? `Web results for “${card.query}” (page ${card.page})`
      : `Web results for “${card.query}”`,
  ]
  if (card.answer) {
    lines.push('', card.answer)
  }
  for (const result of card.results) {
    lines.push('', `${result.position}. ${result.title} — ${result.url}`)
    if (result.snippet) {
      lines.push(`   ${clip(result.snippet, SNIPPET_PREVIEW_CHARS)}`)
    }
  }
  if (card.results.length === 0) {
    lines.push('', 'No results.')
  }
  return lines.join('\n')
}

import {
  attributionFromActorContext,
  completeLedgerAttribution,
  runWebSearch,
  toWebSearchCard,
  type LedgerIdentityService,
} from '@nessie/runtime'
import type { AuthorizedActionContext, WebSearchCard, WebSearchRequest } from '@nessie/schemas'

/**
 * Human-initiated web search — the search card's pager, and the Agent
 * Designer's sidebar lookup.
 *
 * It runs the same `runWebSearch` the agent builtin runs, so which provider
 * answers, how the response is normalised and how the unit is metered are
 * decided in exactly one place. What differs is the provenance: this search is
 * signed as the person who asked for it, with `web-search` as the system
 * component, because nobody's agent ran.
 */

export const isWebSearchConfigured = (
  ledgerIdentity: LedgerIdentityService | null,
  env: NodeJS.ProcessEnv = process.env,
): boolean =>
  Boolean(env.LEDGER_PUBLIC_URL?.trim())
  && Boolean(env.LEDGER_PROXY_TOKEN?.trim())
  && ledgerIdentity !== null

/**
 * The search behind `POST /api/web-search`. The caller has already been
 * authorized and budget-checked; this only runs the search and shapes the card
 * the same way the tool does, so a page fetched by a click and a page fetched
 * by an agent are the same object.
 */
export const searchWebForPerson = async (input: {
  actorContext: AuthorizedActionContext
  ledgerIdentity: LedgerIdentityService
  request: WebSearchRequest
  requestId: string
}): Promise<WebSearchCard> => {
  const output = await runWebSearch(input.request.query, {
    attribution: completeLedgerAttribution(
      attributionFromActorContext(input.actorContext, {
        systemComponent: 'web-search',
      }),
    ),
    ...(input.request.count === undefined ? {} : { count: input.request.count }),
    ledgerIdentity: input.ledgerIdentity,
    ...(input.request.page === undefined ? {} : { page: input.request.page }),
    toolCallId: input.requestId,
  })

  return toWebSearchCard(output)
}

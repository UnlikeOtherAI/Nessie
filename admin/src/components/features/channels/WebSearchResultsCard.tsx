import { useState } from 'react'
import {
  readWebSearchCard,
  WEB_SEARCH_CARD_MAX_PAGE,
  type WebSearchCard,
  type WebSearchCardResult,
} from '@nessie/schemas'

import { useWebSearchPage } from '../../../facades/web-search/hooks'
import { Pill } from '../../primitives/Pill'

/**
 * A page of web results, rendered the way a search engine renders them.
 *
 * The card is presentational, so its whole payload is in the message metadata:
 * opening a thread full of search cards costs no requests and spends nothing.
 * Paging and related searches are the exception — they are searches the reader
 * asked for, so they run through `POST /api/web-search` under their own
 * identity, and each page stays cached under its own key so paging back is
 * free.
 *
 * Standard: docs/standards/web-search.md
 */

// `admin-web-search-card` is what colours the result links: the unlayered
// `a { color: inherit }` in styles.css beats any Tailwind colour utility on an
// anchor, so the link colour has to come from a rule beside it.
const cardShell = [
  'admin-web-search-card mt-2 max-w-2xl rounded-[var(--radius-md)]',
  'border border-[color:var(--sep)] bg-[color:var(--panel)] p-3',
].join(' ')

const pagerButtonClass = [
  'inline-flex h-7 items-center justify-center rounded-[var(--radius-sm)] px-2.5',
  'border border-[color:var(--sep)] bg-[color:var(--overlay-weak)]',
  'text-xs font-semibold text-[color:var(--tx2)]',
  'disabled:cursor-not-allowed disabled:opacity-40',
].join(' ')

const SearchGlyph = () => (
  <svg
    aria-hidden="true"
    className="h-3.5 w-3.5 text-[color:var(--tx3)]"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    viewBox="0 0 24 24"
  >
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" strokeLinecap="round" />
  </svg>
)

const ResultRow = ({ result }: { result: WebSearchCardResult }) => (
  <li className="min-w-0">
    {result.source ? (
      <div className="truncate text-[11px] text-[color:var(--tx3)]">{result.source}</div>
    ) : null}
    <a
      className="block text-sm font-medium"
      href={result.url}
      rel="noreferrer noopener"
      target="_blank"
    >
      {result.title}
    </a>
    {result.snippet ? (
      <p className="mt-0.5 text-xs leading-5 text-[color:var(--tx2)]">
        {result.date ? (
          <span className="text-[color:var(--tx3)]">{result.date} — </span>
        ) : null}
        {result.snippet}
      </p>
    ) : null}
  </li>
)

const AnswerPanel = ({ card }: { card: WebSearchCard }) => {
  const panel = card.knowledgePanel
  const source = card.answerSource ?? panel
  if (!card.answer && !panel?.description) return null

  return (
    <div
      className={[
        'mb-3 rounded-[var(--radius-sm)] border border-[color:var(--sep)]',
        'bg-[color:var(--panel-soft)] p-2.5',
      ].join(' ')}
    >
      {panel?.title ? (
        <div className="text-xs font-semibold text-[color:var(--tx)]">{panel.title}</div>
      ) : null}
      <p className="mt-0.5 text-sm leading-6 text-[color:var(--tx)]">
        {card.answer ?? panel?.description}
      </p>
      {source?.url ? (
        <a
          className="mt-1 inline-block text-[11px]"
          href={source.url}
          rel="noreferrer noopener"
          target="_blank"
        >
          {source.title ?? source.url}
        </a>
      ) : null}
    </div>
  )
}

export const WebSearchResultsCard = ({
  metadata,
}: {
  metadata: Record<string, unknown> | undefined
}) => {
  const posted = readWebSearchCard(metadata)
  // The query can move off the posted one when a related search is followed,
  // so both halves of "which search am I looking at" are held together.
  const [view, setView] = useState<{ page: number; query: string } | null>(null)

  const isPosted =
    posted !== null
    && (view === null || (view.page === posted.page && view.query === posted.query))
  const fetched = useWebSearchPage(
    posted && !isPosted && view ? { count: posted.count, page: view.page, query: view.query } : null,
  )

  if (!posted) return null
  const card = isPosted ? posted : fetched.data ?? null
  const page = view?.page ?? posted.page
  const query = view?.query ?? posted.query
  const canGoBack = page > 1
  const canGoOn = (card?.hasMore ?? false) && page < WEB_SEARCH_CARD_MAX_PAGE

  return (
    <div className={cardShell} data-testid="web-search-card">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <SearchGlyph />
        <span className="min-w-0 flex-1 truncate text-sm text-[color:var(--tx)]">{query}</span>
        <Pill radius="chip" size="sm" tone="muted" uppercase={false}>
          {card?.provider ?? posted.provider}
        </Pill>
      </div>

      {card ? (
        <>
          <AnswerPanel card={card} />
          {card.results.length > 0 ? (
            <ul className="flex list-none flex-col gap-3 p-0">
              {card.results.map((result) => (
                <ResultRow key={result.url} result={result} />
              ))}
            </ul>
          ) : (
            <p className="text-xs text-[color:var(--tx2)]">No results on this page.</p>
          )}
          {card.related?.length ? (
            <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-[color:var(--sep)] pt-2.5">
              <span className="text-[11px] text-[color:var(--tx3)]">Related</span>
              {card.related.map((related) => (
                <button
                  className={`${pagerButtonClass} font-normal`}
                  key={related}
                  onClick={() => setView({ page: 1, query: related })}
                  type="button"
                >
                  {related}
                </button>
              ))}
            </div>
          ) : null}
        </>
      ) : fetched.isError ? (
        <p className="text-xs text-[color:var(--danger)]">
          That page could not be loaded. Try again, or go back to page {posted.page}.
        </p>
      ) : (
        <p className="text-xs text-[color:var(--tx2)]">Searching…</p>
      )}

      <div className="mt-3 flex items-center gap-2 border-t border-[color:var(--sep)] pt-2.5">
        <button
          className={pagerButtonClass}
          disabled={!canGoBack || fetched.isFetching}
          onClick={() => setView({ page: page - 1, query })}
          type="button"
        >
          ‹ Previous
        </button>
        <span className="text-[11px] text-[color:var(--tx3)]">Page {page}</span>
        <button
          className={pagerButtonClass}
          disabled={!canGoOn || fetched.isFetching}
          onClick={() => setView({ page: page + 1, query })}
          type="button"
        >
          Next ›
        </button>
      </div>
    </div>
  )
}

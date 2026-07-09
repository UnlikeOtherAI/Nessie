import type { MessageSearchResult } from '../../../lib/api-client'
import { formatClock } from './channel-helpers'

interface ChannelSearchPanelProps {
  searchQuery: string
  searchResults: MessageSearchResult[]
  onChangeQuery: (value: string) => void
  onClose: () => void
  onSelectResult: (messageId: string) => void
}

// The in-channel message-search dropdown: a query field plus a matching
// results list that scrolls the feed to the selected message.
export const ChannelSearchPanel = ({
  searchQuery,
  searchResults,
  onChangeQuery,
  onClose,
  onSelectResult,
}: ChannelSearchPanelProps) => (
  <div className="border-b border-[color:var(--sep)] px-5 py-2">
    <input
      autoFocus
      className="admin-input w-full text-sm"
      onChange={(event) => onChangeQuery(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          onClose()
        }
      }}
      placeholder="Search messages in this channel"
      type="text"
      value={searchQuery}
    />
    {searchQuery.trim().length > 0 ? (
      <div className="mt-2 max-h-64 overflow-y-auto">
        {searchResults.length === 0 ? (
          <div className="px-1 py-2 text-sm text-[color:var(--tx3)]">
            No matches.
          </div>
        ) : (
          searchResults.map((result) => (
            <button
              key={result.id}
              className="flex w-full flex-col gap-0.5 rounded-lg px-2 py-2 text-left hover:bg-[color:var(--overlay-weak)]"
              onClick={() => onSelectResult(result.id)}
              type="button"
            >
              <span className="flex items-center gap-2 text-xs text-[color:var(--tx3)]">
                <span className="font-semibold text-[color:var(--tx2)]">
                  {result.authorName}
                </span>
                #{result.channelLabel} · {formatClock(result.createdAt)}
              </span>
              <span className="truncate text-sm text-[color:var(--tx)]">
                {result.snippet}
              </span>
            </button>
          ))
        )}
      </div>
    ) : null}
  </div>
)

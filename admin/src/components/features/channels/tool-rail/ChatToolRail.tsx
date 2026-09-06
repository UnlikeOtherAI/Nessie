import type { ReactElement } from 'react'

import { CHAT_TOOLS, type ChatToolId } from './chat-tools'

type ChatToolRailProps = {
  /** Tools with something happening right now get a live dot. */
  liveTools: ReadonlySet<ChatToolId>
  openTool: ChatToolId | null
  onToggle: (tool: ChatToolId) => void
}

const BrowserMark = () => (
  <svg
    aria-hidden="true"
    className="h-5 w-5"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    viewBox="0 0 24 24"
  >
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" strokeLinecap="round" />
    <path d="M12 3c2.5 2.6 3.75 5.6 3.75 9S14.5 18.4 12 21C9.5 18.4 8.25 15.4 8.25 12S9.5 5.6 12 3Z" />
  </svg>
)

const TOOL_MARKS: Record<ChatToolId, () => ReactElement> = {
  browser: BrowserMark,
}

/**
 * The agent's tools, standing beside its conversation.
 *
 * It is a rail rather than a menu because it is persistent: the point is to
 * see, without opening anything, that this agent has a browser and whether it
 * is running. Selecting a tool opens its column next to the chat — the chat
 * narrows, nothing is covered — and selecting it again closes it.
 *
 * The idiom is the shell's own navigation rail (`.admin-rail-btn`), not a
 * second one: same tile, same active fill, same 65px column, so the two rails
 * on a wide screen read as one system.
 */
export const ChatToolRail = ({ liveTools, onToggle, openTool }: ChatToolRailProps) => (
  <aside
    aria-label="Agent tools"
    className={[
      'flex h-full w-[65px] flex-shrink-0 flex-col items-center gap-1 overflow-y-auto',
      'border-l border-[color:var(--sep)] bg-[color:var(--rail)] px-2 py-2',
    ].join(' ')}
  >
    {CHAT_TOOLS.map((tool) => {
      const Mark = TOOL_MARKS[tool.id]
      const live = liveTools.has(tool.id)
      return (
        <button
          aria-pressed={openTool === tool.id}
          className={`admin-rail-btn ${openTool === tool.id ? 'active' : ''}`}
          key={tool.id}
          onClick={() => onToggle(tool.id)}
          title={tool.description}
          type="button"
        >
          <span className="admin-rail-btn-icon relative">
            <Mark />
            {live ? (
              <span
                aria-hidden="true"
                className="absolute right-1 top-1 h-2 w-2 rounded-full bg-[color:var(--success)]"
              />
            ) : null}
          </span>
          <span className="admin-rail-btn-label">{tool.label}</span>
          {live ? <span className="sr-only">Running now</span> : null}
        </button>
      )
    })}
  </aside>
)

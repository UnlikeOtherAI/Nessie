import type { ReactElement } from 'react'

import type { ChatTool, ChatToolId } from './chat-tools'

type ChatToolRailProps = {
  /**
   * Why a tool cannot open right now, or absent when it can. The rail says it
   * rather than swallowing the press: a button that looks live and does
   * nothing is worse than one that explains itself.
   */
  blockedReason: string | null
  /** Tools with something happening right now get a live dot. */
  liveTools: ReadonlySet<ChatToolId>
  openTool: ChatToolId | null
  /**
   * The tools this agent has (`availableChatTools`), in table order. The rail
   * draws exactly these: a button for a capability the agent does not have is
   * a door onto an empty room.
   */
  tools: readonly ChatTool[]
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

const ConversationsMark = () => (
  <svg
    aria-hidden="true"
    className="h-5 w-5"
    fill="none"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth="1.6"
    viewBox="0 0 24 24"
  >
    <path d="M8.5 15.5H6l-3 3v-11a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H8.5Z" />
    <path d="M9.5 11.5v2a2 2 0 0 0 2 2h5l2.5 2.5v-8a2 2 0 0 0-2-2h-2" />
  </svg>
)

const TOOL_MARKS: Record<ChatToolId, () => ReactElement> = {
  browser: BrowserMark,
  conversations: ConversationsMark,
}

/** What a live dot on each tool means, read out to a screen reader. */
const LIVE_LABELS: Record<ChatToolId, string> = {
  browser: 'Browsing now',
  conversations: 'Another conversation is running',
}

/**
 * The agent's tools, standing beside its conversation.
 *
 * It is a rail rather than a menu because it is persistent: the point is to
 * see, without opening anything, that this agent has a browser and whether it
 * is running. Selecting a tool opens its column next to the chat — the chat
 * narrows, nothing is covered — and selecting it again closes it.
 *
 * The idiom is the shell's own navigation rail (`.admin-rail-btn`), down to
 * the label under the glyph and no hover tooltip: the shell portals those
 * because its rail clips, and a right-edge rail has nowhere to portal to.
 */
export const ChatToolRail = ({
  blockedReason,
  liveTools,
  onToggle,
  openTool,
  tools,
}: ChatToolRailProps) => (
  <aside
    aria-label="Agent tools"
    className={[
      'flex h-full w-[65px] flex-shrink-0 flex-col items-center overflow-x-hidden overflow-y-auto',
      'border-l border-[color:var(--sep)] bg-[color:var(--rail)] px-2 py-2',
    ].join(' ')}
  >
    {tools.map((tool) => {
      const Mark = TOOL_MARKS[tool.id]
      const live = liveTools.has(tool.id)
      return (
        <button
          // `aria-disabled` rather than `disabled`: a disabled button shows no
          // tooltip in Safari, and the reason is the whole point of leaving
          // the button on screen.
          aria-disabled={blockedReason !== null}
          aria-pressed={openTool === tool.id}
          className={`admin-rail-btn ${openTool === tool.id ? 'active' : ''} ${
            blockedReason === null ? '' : 'cursor-not-allowed opacity-50'}`}
          key={tool.id}
          onClick={() => { if (blockedReason === null) onToggle(tool.id) }}
          title={blockedReason ?? undefined}
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
          {live ? <span className="sr-only">{LIVE_LABELS[tool.id]}</span> : null}
          {blockedReason === null ? null : <span className="sr-only">{blockedReason}</span>}
        </button>
      )
    })}
  </aside>
)

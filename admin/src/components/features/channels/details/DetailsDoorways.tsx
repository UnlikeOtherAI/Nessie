import { RAIL_POLL_MS, useThreadBrowserSessions } from '../../../../facades/browser-cloud/hooks'
import type { ChatTool, ChatToolId } from '../tool-rail/chat-tools'

const Disclosure = ({
  detail,
  label,
  onClick,
}: {
  detail?: string
  label: string
  onClick: () => void
}) => (
  <button
    className="flex w-full items-center gap-3 border-b border-[color:var(--sep)] px-1 py-3 text-left transition-colors last:border-b-0 hover:bg-[color:var(--overlay-weak)]"
    onClick={onClick}
    type="button"
  >
    <span className="min-w-0 flex-1">
      <span className="block text-sm font-semibold text-[color:var(--tx)]">{label}</span>
      {detail ? <span className="mt-0.5 block truncate text-xs text-[color:var(--tx3)]">{detail}</span> : null}
    </span>
    <svg aria-hidden="true" className="h-5 w-5 flex-shrink-0 text-[color:var(--tx3)]" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
      <path d="m9 18 6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  </button>
)

type DetailsDoorwaysProps = {
  onOpenFiles: () => void
  onOpenTool: (tool: ChatToolId) => void
  threadId: string | null
  /**
   * The tools this conversation's agents actually have (`availableChatTools`),
   * or empty where no agent works here.
   */
  tools: readonly ChatTool[]
}

/**
 * What else this conversation holds, as doorways: its agent's Conversations
 * and Browser, and its Files and links. The tool rows read the same table as
 * the rail (`CHAT_TOOLS`) and open the same route the conversation header's
 * own tool action opens — a second doorway, never a second implementation.
 */
export const DetailsDoorways = ({ onOpenFiles, onOpenTool, threadId, tools }: DetailsDoorwaysProps) => {
  const sessions = useThreadBrowserSessions(tools.length > 0 ? threadId : null, {
    refetchInterval: RAIL_POLL_MS,
  })
  const browsing = (sessions.data?.sessions.length ?? 0) > 0
  return (
    <nav aria-label="In this conversation" className="grid">
      {tools.map((tool) => (
        <Disclosure
          detail={tool.id === 'browser' && browsing ? 'Browsing now — watch what it sees' : tool.description}
          key={tool.id}
          label={tool.label}
          onClick={() => onOpenTool(tool.id)}
        />
      ))}
      <Disclosure detail="Everything shared in this conversation" label="Files and links" onClick={onOpenFiles} />
    </nav>
  )
}

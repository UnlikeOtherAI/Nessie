import { useThreadBrowserSessions } from '../../../facades/browser-cloud/hooks'

type AgentScreenDisclosureProps = {
  threadId: string | null
  onOpen: (sessionId: string) => void
}

/**
 * The in-context doorway: "Agent's screen" in the conversation info drawer,
 * shown only while an agent actually has a browser open.
 *
 * A capability nobody can reach is unfinished, and the owning surface (the
 * panel) is not somewhere a person would think to look — the question "what is
 * it doing right now" arises in the conversation, so the answer lives here.
 * It renders nothing when there is no live browser rather than a disabled row,
 * because an always-present row that is usually dead teaches people to ignore
 * it.
 */
export const AgentScreenDisclosure = ({ threadId, onOpen }: AgentScreenDisclosureProps) => {
  const sessions = useThreadBrowserSessions(threadId)
  const live = sessions.data?.sessions ?? []
  if (live.length === 0) return null

  return (
    <>
      {live.map((session) => (
        <button
          className="flex w-full items-center gap-3 border-b border-[color:var(--sep)] px-5 py-4 text-left transition-colors hover:bg-[color:var(--overlay-weak)]"
          key={session.id}
          onClick={() => onOpen(session.id)}
          type="button"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-[color:var(--tx)]">
              {session.agentName}’s screen
            </span>
            <span className="mt-0.5 block truncate text-xs text-[color:var(--tx3)]">
              Browsing now — watch what it sees
            </span>
          </span>
          <span
            aria-hidden="true"
            className="h-2 w-2 flex-shrink-0 rounded-full bg-[color:var(--success)]"
          />
        </button>
      ))}
    </>
  )
}

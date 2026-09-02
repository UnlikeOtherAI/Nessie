import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { AgentRecord } from '../../../lib/api-client'
import { useRunThinkingLog } from '../../../facades/threads/hooks'
import {
  mergeThinkingEntries,
  toThinkingBlocks,
  toThinkingEntries,
  type PendingStreamMessage,
} from '../../../facades/threads/thinking'
import { useOverlay } from '../../overlays/useOverlay'
import { AgentAvatar } from '../../shared/AgentAvatar'

type ThoughtProcessDialogProps = {
  agent: AgentRecord | null
  agentName: string
  entry: PendingStreamMessage
  onClose: () => void
  // The run is still publishing; false once `stream.done` removed it and the
  // reply landed in the feed.
  streaming: boolean
  threadId?: string
  token: string | null
}

// Below this distance from the bottom the reader is treated as following the
// stream, and new thought is scrolled into view.
const PIN_THRESHOLD_PX = 24

export const ThoughtProcessDialog = ({
  agent,
  agentName,
  entry,
  onClose,
  streaming,
  threadId,
  token,
}: ThoughtProcessDialogProps) => {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [pinned, setPinned] = useState(true)
  const close = useCallback(() => onClose(), [onClose])
  const overlay = useOverlay({
    id: `thought-process-${entry.runId}`,
    kind: 'modal',
    label: `Close ${agentName} thought process`,
    onClose: close,
    open: true,
  })

  // A bubble seeded from the bootstrap only holds a tail of the log, so the
  // full record is read from the API and merged under the live chunks.
  const logQuery = useRunThinkingLog(
    threadId,
    entry.runId,
    Boolean(entry.seededFromBootstrap),
  )
  const blocks = useMemo(
    () =>
      toThinkingBlocks(
        mergeThinkingEntries(entry.thinking, toThinkingEntries(logQuery.data?.entries)),
      ),
    [entry.thinking, logQuery.data?.entries],
  )
  const tailLength = blocks[blocks.length - 1]?.text.length ?? 0

  useLayoutEffect(() => {
    const container = scrollRef.current
    if (!pinned || !container) {
      return
    }
    container.scrollTop = container.scrollHeight
  }, [blocks.length, pinned, tailLength])

  return (
    // Not the shared `Dialog`: a fixed-header + independently-scrolling log +
    // fixed-footer flex column at `max-w-3xl` with a `text-base` heading —
    // none of the shell's four panel geometries express that split, and a
    // scrim that stops Escape from also closing the reply panel underneath.
    // `useOverlay` still gives it the Back registration, focus trap,
    // drag-safe scrim and layer every other overlay gets
    // (docs/navigation/overview.md §7).
    <div
      {...overlay.scrimProps}
      className="fixed inset-0 flex items-center justify-center bg-[var(--scrim-strong)] p-4 backdrop-blur-sm"
      onKeyDown={(event) => {
        // The dialog can be opened from inside the reply panel, which closes
        // itself on a window-level Escape. Its own Escape must not close both.
        if (event.key === 'Escape') {
          event.stopPropagation()
        }
      }}
      style={overlay.layerStyle}
    >
      <div
        aria-labelledby="thought-process-title"
        aria-modal="true"
        className={[
          'flex max-h-[calc(100dvh-2rem)] w-full max-w-3xl flex-col overflow-hidden',
          'rounded-xl border border-[var(--sep)] bg-[var(--panel)] shadow-2xl',
        ].join(' ')}
        data-testid="thought-process-dialog"
        ref={overlay.panelRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="flex flex-shrink-0 items-center justify-between gap-4 border-b border-[var(--sep)] px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <AgentAvatar agent={agent} size="sm" token={token} />
            <div className="min-w-0">
              <h2 className="truncate text-base font-semibold text-[var(--tx)]" id="thought-process-title">
                {agentName}
              </h2>
              <p className="text-xs text-[color:var(--tx3)]">Thought process</p>
            </div>
          </div>
          <button
            aria-label="Close thought process"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-[var(--tx3)] hover:bg-[var(--overlay)] hover:text-[var(--tx)]"
            onClick={close}
            type="button"
          >
            ×
          </button>
        </header>

        <div
          className="min-h-0 flex-1 overflow-y-auto px-5 py-4"
          data-testid="thought-process-log"
          onScroll={() => {
            const container = scrollRef.current
            if (!container) {
              return
            }
            const distance =
              container.scrollHeight - container.scrollTop - container.clientHeight
            setPinned(distance <= PIN_THRESHOLD_PX)
          }}
          ref={scrollRef}
        >
          {logQuery.data?.truncated ? (
            <p className="mb-3 rounded-lg border border-dashed border-[color:var(--sep)] px-3 py-2 text-xs text-[color:var(--tx3)]">
              Earlier thinking was trimmed from this log.
            </p>
          ) : null}
          <ThoughtProcessBody blocks={blocks} />
        </div>

        <footer className="flex flex-shrink-0 items-center gap-2 border-t border-[var(--sep)] px-5 py-3 text-xs text-[color:var(--tx3)]">
          {streaming ? (
            <>
              <span className="thinking-dots" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              Still thinking — this updates live.
            </>
          ) : (
            <>Reply posted. This is the complete record for that run.</>
          )}
        </footer>
      </div>
    </div>
  )
}

const ThoughtProcessBody = ({
  blocks,
}: {
  blocks: ReturnType<typeof toThinkingBlocks>
}): ReactNode => {
  if (blocks.length === 0) {
    return (
      <p className="text-sm text-[color:var(--tx3)]">No thought process recorded yet.</p>
    )
  }

  return (
    <>
      {blocks.map((block) =>
        block.kind === 'tool' ? (
          <div
            className="mt-2 flex items-start gap-2 rounded-lg bg-[var(--overlay-weak)] px-3 py-1.5 text-xs text-[color:var(--tx2)]"
            key={block.key}
          >
            <span aria-hidden="true">⚙</span>
            <span className="min-w-0 break-words">{block.text}</span>
          </div>
        ) : (
          <p
            className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-[color:var(--tx2)]"
            key={block.key}
          >
            {block.text}
          </p>
        ),
      )}
    </>
  )
}

type AgentIdentity = {
  agent: AgentRecord | null
  name: string
}

/**
 * Owns the thought-process dialog for a feed. The dialog outlives the bubble on
 * purpose: `stream.done` removes the pending entry (and its bubble), but a
 * reader who opened the record keeps it until they close it, so the last known
 * entry is retained here rather than in the bubble.
 */
export const useThoughtProcessDialog = (
  pendingMessages: PendingStreamMessage[],
  resolveAgentIdentity: (agentId: string) => AgentIdentity,
  threadId: string | undefined,
  token: string | null,
) => {
  const [runId, setRunId] = useState<string | null>(null)
  const [retained, setRetained] = useState<PendingStreamMessage | null>(null)
  const live = runId
    ? pendingMessages.find((message) => message.runId === runId) ?? null
    : null

  useEffect(() => {
    if (!runId) {
      setRetained(null)
      return
    }
    if (live) {
      setRetained(live)
    }
  }, [live, runId])

  const entry = live ?? (retained && retained.runId === runId ? retained : null)
  const identity = entry ? resolveAgentIdentity(entry.agentId) : null
  const openThoughtProcess = useCallback((nextRunId: string) => setRunId(nextRunId), [])

  return {
    openThoughtProcess,
    thoughtProcessDialog:
      entry && identity ? (
        <ThoughtProcessDialog
          agent={identity.agent}
          agentName={identity.name}
          entry={entry}
          streaming={Boolean(live)}
          threadId={threadId}
          token={token}
          onClose={() => setRunId(null)}
        />
      ) : null,
  }
}

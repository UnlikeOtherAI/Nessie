import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { useViewport } from '../../../hooks/useViewport'
import { Popover } from '../../overlays/Popover'
import type { MessageReaction } from '../../../lib/api-client'

// Resolves the human-readable name of one reaction's author (user or agent).
// Built once per feed (channel members + message authors + agent map + "You").
export type ResolveReactorName = (reaction: MessageReaction) => string

const LONG_PRESS_MS = 450
const MAX_NAMED_REACTORS = 4

type ReactionSummary = {
  count: number
  emoji: string
  names: string[]
  reactedByMe: boolean
}

const summarizeReactions = (
  reactions: MessageReaction[],
  currentUserId: string,
  resolveReactorName: ResolveReactorName,
): ReactionSummary[] => {
  const byEmoji = new Map<string, ReactionSummary>()
  for (const reaction of reactions) {
    const summary = byEmoji.get(reaction.emoji) ?? {
      count: 0,
      emoji: reaction.emoji,
      names: [],
      reactedByMe: false,
    }
    summary.count += 1
    summary.names.push(resolveReactorName(reaction))
    summary.reactedByMe ||= reaction.userId === currentUserId
    byEmoji.set(reaction.emoji, summary)
  }
  return Array.from(byEmoji.values())
}

// "Alice", "Alice and Bob", "Alice, Bob and Cara", "Alice, ... and 3 others".
const formatReactorNames = (names: string[]): string => {
  const shown = names.slice(0, MAX_NAMED_REACTORS)
  const hidden = names.length - shown.length
  if (hidden > 0) {
    return `${shown.join(', ')} and ${hidden} ${hidden === 1 ? 'other' : 'others'}`
  }
  if (shown.length <= 1) {
    return shown[0] ?? 'Someone'
  }
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`
}

type ReactionPillProps = {
  summary: ReactionSummary
  onToggle: (emoji: string) => void
}

// One emoji pill with its "who reacted" popover: shown on hover (fine
// pointers), keyboard focus, and long-press (touch); dismissed on leave,
// blur, Escape, or an outside press. Placement — above the pill, flipped
// below when the pill sits near the top of the window, clamped horizontally
// — belongs to the Popover primitive.
const ReactionPill = ({ summary, onToggle }: ReactionPillProps) => {
  const { count, emoji, names, reactedByMe } = summary
  const popoverId = useId()
  const pillRef = useRef<HTMLButtonElement>(null)
  const pressTimer = useRef<number | null>(null)
  const suppressClick = useRef(false)
  const [open, setOpen] = useState(false)
  // Hover is a pointer capability, not a width: the viewport store owns it.
  const canHover = useViewport().capabilities.hover

  const toggleLabel = reactedByMe
    ? `Remove ${emoji} reaction`
    : `Add ${emoji} reaction`

  const clearPressTimer = () => {
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current)
      pressTimer.current = null
    }
  }

  useEffect(() => clearPressTimer, [])

  const openFromHover = () => {
    if (canHover) setOpen(true)
  }

  const startLongPress = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType !== 'touch') {
      return
    }
    clearPressTimer()
    // A previous long-press that never produced a click must not swallow the
    // next tap's toggle.
    suppressClick.current = false
    pressTimer.current = window.setTimeout(() => {
      pressTimer.current = null
      suppressClick.current = true
      setOpen(true)
    }, LONG_PRESS_MS)
  }

  const handleClick = () => {
    // A completed long-press shows who reacted; it must not also toggle.
    if (suppressClick.current) {
      suppressClick.current = false
      return
    }
    onToggle(emoji)
  }

  const handleFocus = (event: FocusEvent<HTMLButtonElement>) => {
    if (event.target.matches(':focus-visible')) {
      setOpen(true)
    }
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Escape' && open) {
      event.stopPropagation()
      setOpen(false)
    }
  }

  const handleContextMenu = (event: MouseEvent<HTMLButtonElement>) => {
    // Long-press on touch devices must open the popover, not the browser menu.
    if (open || suppressClick.current) {
      event.preventDefault()
    }
  }

  return (
    <span
      className="reaction-pill-wrap"
      onMouseEnter={openFromHover}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        aria-describedby={open ? popoverId : undefined}
        aria-label={toggleLabel}
        aria-pressed={reactedByMe}
        className={reactedByMe ? 'reaction-pill reaction-pill-active' : 'reaction-pill'}
        type="button"
        onBlur={() => setOpen(false)}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        onFocus={handleFocus}
        onKeyDown={handleKeyDown}
        onPointerCancel={clearPressTimer}
        onPointerDown={startLongPress}
        onPointerLeave={clearPressTimer}
        onPointerUp={clearPressTimer}
        ref={pillRef}
      >
        {emoji}
        {count > 1 ? ` ${count}` : ''}
      </button>
      <Popover
        anchorRef={pillRef}
        className="reaction-pill-popover"
        id={popoverId}
        label={`${formatReactorNames(names)} reacted with ${emoji}`}
        onClose={() => setOpen(false)}
        open={open}
        placement="top-start"
        role="tooltip"
      >
        <span className="reaction-pill-popover-emoji">{emoji}</span>
        <span>
          <span className="font-semibold text-[color:var(--tx)]">
            {formatReactorNames(names)}
          </span>
          <span className="text-[color:var(--tx3)]">
            {` reacted with ${emoji}`}
          </span>
        </span>
      </Popover>
    </span>
  )
}

type ReactionPillsProps = {
  currentUserId: string
  reactions: MessageReaction[]
  resolveReactorName: ResolveReactorName
  onToggle: (emoji: string) => void
}

// The row of per-emoji reaction pills under a message. Clicking a pill toggles
// the viewer's own reaction; hover / focus / long-press reveals who reacted.
export const ReactionPills = ({
  currentUserId,
  reactions,
  resolveReactorName,
  onToggle,
}: ReactionPillsProps) => {
  const summaries = useMemo(
    () => summarizeReactions(reactions, currentUserId, resolveReactorName),
    [currentUserId, reactions, resolveReactorName],
  )

  if (summaries.length === 0) {
    return null
  }

  return (
    <div
      className="mt-1 flex flex-wrap gap-1"
      onClick={(event: MouseEvent<HTMLDivElement>) => event.stopPropagation()}
    >
      {summaries.map((summary) => (
        <ReactionPill key={summary.emoji} summary={summary} onToggle={onToggle} />
      ))}
    </div>
  )
}

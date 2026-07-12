import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
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
// blur, Escape, or an outside tap. Flips to right-anchored when it would
// overflow the viewport.
const ReactionPill = ({ summary, onToggle }: ReactionPillProps) => {
  const { count, emoji, names, reactedByMe } = summary
  const popoverId = useId()
  const wrapRef = useRef<HTMLSpanElement>(null)
  const popoverRef = useRef<HTMLSpanElement>(null)
  const pressTimer = useRef<number | null>(null)
  const suppressClick = useRef(false)
  const [open, setOpen] = useState(false)
  const [align, setAlign] = useState<'left' | 'right'>('left')

  const toggleLabel = reactedByMe
    ? `Remove ${emoji} reaction`
    : `Add ${emoji} reaction`

  const clearPressTimer = () => {
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current)
      pressTimer.current = null
    }
  }

  // Long-press-opened popovers have no hover-out to dismiss them: close on the
  // next pointer interaction anywhere outside the pill.
  useEffect(() => {
    if (!open) {
      return undefined
    }
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer)
  }, [open])

  // Keep the popover inside the viewport: measure once visible and anchor it
  // to the pill's right edge when the default left anchor would overflow.
  useLayoutEffect(() => {
    if (!open) {
      setAlign('left')
      return
    }
    const wrap = wrapRef.current
    const popover = popoverRef.current
    if (!wrap || !popover) {
      return
    }
    const overflows =
      wrap.getBoundingClientRect().left + popover.offsetWidth > window.innerWidth - 12
    setAlign(overflows ? 'right' : 'left')
  }, [open])

  useEffect(() => clearPressTimer, [])

  const openFromHover = () => {
    if (window.matchMedia('(hover: hover)').matches) {
      setOpen(true)
    }
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
      ref={wrapRef}
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
      >
        {emoji}
        {count > 1 ? ` ${count}` : ''}
      </button>
      {open ? (
        <span
          className="reaction-pill-popover"
          data-align={align}
          id={popoverId}
          ref={popoverRef}
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
        </span>
      ) : null}
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

import { useId, useState, type ReactNode } from 'react'

type HoverHintProps = {
  /** The visible mark this hint explains — an icon, a dot, a count. */
  children: ReactNode
  /** Geometry and colour for the trigger itself; the hint styles itself. */
  className?: string
  /** The sentence: what the state means, or what to do about it. */
  description: string
  /** The hint's title, and the accessible name's first half. */
  label: string
  testId?: string
}

/**
 * A compact mark with its explanation on demand.
 *
 * It is a real `<button>`, not a native `title`: a title is invisible on touch,
 * cannot be reached by keyboard, and cannot carry two lines. So hover, focus
 * and tap all open the same panel, and Escape closes it. That costs the tap
 * falling through to whatever sits behind the mark, which is the right trade
 * where the mark is the only place a state is written down.
 *
 * This is the admin's shared version of a pattern that had already been
 * hand-written five times (`AppIconBadge`, `ReactionPills`, `UserStatusEmoji`,
 * `RailTooltip`, `GroupDmSidebarLabel`). Only the two apps-card call sites are
 * on it so far; the other three are a separate migration.
 */
export const HoverHint = ({
  children,
  className = '',
  description,
  label,
  testId,
}: HoverHintProps) => {
  const [open, setOpen] = useState(false)
  const tooltipId = useId()

  return (
    <button
      aria-describedby={open ? tooltipId : undefined}
      aria-label={`${label}. ${description}`}
      className={[
        // A stacking context so the hint below escapes its siblings, named
        // from the layer scale rather than a literal (docs/navigation §7).
        'relative z-[var(--layer-stack)] inline-flex shrink-0 items-center justify-center',
        'transition-colors duration-[var(--duration-fast)]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]',
        className,
      ].join(' ')}
      data-testid={testId}
      onBlur={() => setOpen(false)}
      onClick={() => setOpen((current) => !current)}
      // Tabbing to the mark opens it, so a keyboard user reads the explanation
      // by arriving rather than by pressing a button whose only effect is this
      // panel. The version this was extracted from closed on blur but never
      // opened on focus, which left the mark silent to that reader.
      onFocus={() => setOpen(true)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setOpen(false)
      }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      type="button"
    >
      {children}
      <span
        className={[
          'pointer-events-none absolute bottom-full left-1/2 mb-2 w-max max-w-64',
          'z-[var(--layer-popover)]',
          '-translate-x-1/2 rounded-md border border-[color:var(--sep)]',
          'bg-[color:var(--panel)] p-2 text-left text-xs font-normal normal-case leading-4',
          'tracking-normal text-[color:var(--tx)] shadow-lg',
          open ? 'block' : 'hidden',
        ].join(' ')}
        id={tooltipId}
        role="tooltip"
      >
        <strong className="block font-semibold">{label}</strong>
        <span className="mt-0.5 block text-[color:var(--tx2)]">{description}</span>
      </span>
    </button>
  )
}

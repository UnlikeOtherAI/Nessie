import type { ReactNode } from 'react'

/**
 * `info` and `neutral` were added on 2026-09-01. They are not decoration: the
 * three-tone union was the stated reason five surfaces hand-rolled a banner
 * rather than use this component — `ConnectProgress`'s `needs_secret` step,
 * `ReviewPanel`'s accent strip, `PersonalAssistantSurface`'s config banner,
 * `DeepWaterResearchLauncher`'s warning box, and the autosave "Saved" line the
 * content system now owes every silently-saving control. `--info-*` is already
 * declared by every theme; `neutral` reuses the overlay/`--tx2` pair that a
 * quiet inline note ships with everywhere else.
 */
export type NoticeTone = 'danger' | 'info' | 'neutral' | 'success' | 'warning'

export type NoticeSize = 'md' | 'sm'

export type NoticeRadius = 'lg' | 'md' | 'xl'

export type NoticePadding = 'lg' | 'md'

/**
 * A banner that appears after an async action has to announce itself, and the
 * two spellings differ in urgency: `alert` interrupts the screen reader,
 * `status` waits for a pause. Both need to sit on the banner element itself —
 * a wrapper would announce the wrong region — so the role is a prop rather
 * than something a call site can layer on.
 *
 * The content system's rule: a failure carries `role="alert"`, a success
 * carries `role="status"`, and a banner that is merely context carries
 * neither.
 */

type NoticeProps = {
  children: ReactNode
  className?: string
  padding?: NoticePadding
  radius?: NoticeRadius
  role?: 'alert' | 'status'
  size?: NoticeSize
  tone: NoticeTone
}

const toneClasses: Record<NoticeTone, string> = {
  danger:
    'border-[color:var(--danger-border)] bg-[color:var(--danger-soft)] text-[color:var(--danger-text)]',
  info:
    'border-[color:var(--info-border)] bg-[color:var(--info-soft)] text-[color:var(--info-text)]',
  neutral:
    'border-[color:var(--sep)] bg-[color:var(--overlay-weak)] text-[color:var(--tx2)]',
  success:
    'border-[color:var(--success-border)] bg-[color:var(--success-soft)] text-[color:var(--success-text)]',
  warning:
    'border-[color:var(--warning-border)] bg-[color:var(--warning-soft)] text-[color:var(--warning-text)]',
}

const sizeClasses: Record<NoticeSize, string> = {
  md: 'text-sm',
  sm: 'text-xs',
}

/**
 * Geometry is a prop, never a class the caller layers on top. Two radius (or
 * two padding) utilities in one class string resolve by stylesheet source
 * order, not by the order they were written, so `className="rounded-xl"` over
 * a built-in `rounded-md` is a coin flip. Every value here is one a shipping
 * banner actually uses.
 */
const radiusClasses: Record<NoticeRadius, string> = {
  lg: 'rounded-lg',
  md: 'rounded-md',
  xl: 'rounded-xl',
}

const paddingClasses: Record<NoticePadding, string> = {
  lg: 'p-3',
  md: 'px-3 py-2',
}

/**
 * Always a `div`. Every shipping banner is a block of its own, so an element
 * prop would only be a seam for one to drift into a paragraph and lose the
 * block semantics the layout around it assumes.
 */
export const Notice = ({
  children,
  className,
  padding = 'md',
  radius = 'md',
  role,
  size = 'md',
  tone,
}: NoticeProps) => (
  <div
    className={[
      'border',
      radiusClasses[radius],
      paddingClasses[padding],
      sizeClasses[size],
      toneClasses[tone],
      className ?? '',
    ]
      .filter(Boolean)
      .join(' ')}
    role={role}
  >
    {children}
  </div>
)

import type { IconDefinition } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { HoverHint } from '../../primitives/HoverHint'
import type { PillTone } from '../../primitives/Pill'

type AppIconBadgeProps = {
  description: string
  icon: IconDefinition
  label: string
  testId?: string
  tone: PillTone
}

/**
 * The exact fill/foreground pair the shared `Pill` renders per tone. `Pill`
 * owns that decision but does not export it, and this badge is a round
 * icon-only control rather than `Pill`'s own markup — so this is the one
 * apps-local mirror of it, replacing what used to be two independent copies
 * (`AppCard`'s `KIND_PILL_TONE`, `app-trust.ts`'s per-level `toneClass`) that
 * had drifted apart (`muted`'s text tone was `--tx2` in one, `--tx3` in the
 * other).
 */
const TONE_CLASS: Record<PillTone, string> = {
  accent: 'bg-[color:var(--accent-soft)] text-[color:var(--thinking)]',
  danger: 'bg-[color:var(--danger-soft)] text-[color:var(--danger-text)]',
  info: 'bg-[color:var(--info-soft)] text-[color:var(--info-text)]',
  muted: 'bg-[color:var(--overlay-weak)] text-[color:var(--tx3)]',
  outline: 'border border-[color:var(--sep)] text-[color:var(--tx2)]',
  success: 'bg-[color:var(--success-soft)] text-[color:var(--success-text)]',
  warning: 'bg-[color:var(--warning-soft)] text-[color:var(--warning-text)]',
}

/**
 * A card attribute as a round tinted icon, explained on demand. Everything
 * about revealing that explanation belongs to `HoverHint`, which the card's
 * status dot shares — this component decides only the badge's shape and tone.
 */
export const AppIconBadge = ({
  description,
  icon,
  label,
  testId,
  tone,
}: AppIconBadgeProps) => (
  <HoverHint
    className={`h-6 w-6 rounded-full ${TONE_CLASS[tone]}`}
    description={description}
    label={label}
    testId={testId}
  >
    <FontAwesomeIcon className="h-3 w-3" icon={icon} />
  </HoverHint>
)

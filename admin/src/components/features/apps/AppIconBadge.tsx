import type { IconDefinition } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useId, useState } from 'react'

type AppIconBadgeProps = {
  description: string
  icon: IconDefinition
  label: string
  testId?: string
  toneClass: string
}

/**
 * A compact card attribute with its explanation on demand. It is a button
 * rather than a native-title decoration so touch and keyboard users receive
 * the same HTML tooltip as a pointer hover.
 */
export const AppIconBadge = ({
  description,
  icon,
  label,
  testId,
  toneClass,
}: AppIconBadgeProps) => {
  const [open, setOpen] = useState(false)
  const tooltipId = useId()

  return (
    <button
      aria-describedby={open ? tooltipId : undefined}
      aria-label={`${label}. ${description}`}
      className={[
        'relative z-10 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full',
        'transition-colors duration-[var(--duration-fast)]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]',
        toneClass,
      ].join(' ')}
      data-testid={testId}
      onBlur={() => setOpen(false)}
      onClick={() => setOpen((current) => !current)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setOpen(false)
      }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      type="button"
    >
      <FontAwesomeIcon className="h-3 w-3" icon={icon} />
      <span
        className={[
          'pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 w-max max-w-64',
          '-translate-x-1/2 rounded-md border border-[color:var(--sep)]',
          'bg-[color:var(--panel)] p-2 text-left text-xs font-normal leading-4',
          'text-[color:var(--tx)] shadow-lg',
          open ? 'block' : 'hidden',
        ].join(' ')}
        id={tooltipId}
        role="tooltip"
      >
        <strong className="block font-semibold">{label}</strong>
        <span className="mt-0.5 block">{description}</span>
      </span>
    </button>
  )
}

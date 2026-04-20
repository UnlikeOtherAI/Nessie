import type { ReactNode } from 'react'
import { faChevronRight } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'

type ColumnBrowserItemProps = {
  caption?: string
  children?: ReactNode
  isSelected?: boolean
  meta?: ReactNode
  onClick: () => void
  subtitle?: ReactNode
  title: ReactNode
}

export const ColumnBrowserItem = ({
  caption,
  children,
  isSelected = false,
  meta,
  onClick,
  subtitle,
  title,
}: ColumnBrowserItemProps) => (
  <button
    className={[
      'w-full rounded-xl border p-3 text-left transition',
      isSelected
        ? 'border-emerald-400/60 bg-emerald-400/10'
        : 'border-[color:var(--sep)] bg-black/10 hover:bg-black/20',
    ].join(' ')}
    onClick={onClick}
    type="button"
  >
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="truncate font-semibold text-white">{title}</div>
        {subtitle ? (
          <div className="mt-1 text-xs text-[color:var(--tx3)]">{subtitle}</div>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        {meta ? meta : null}
        <FontAwesomeIcon
          className="h-4 w-4 flex-shrink-0 text-[color:var(--tx3)]"
          icon={faChevronRight}
        />
      </div>
    </div>
    {children ? (
      <div className="mt-2 text-sm text-[color:var(--tx2)]">{children}</div>
    ) : null}
    {caption ? (
      <div className="mt-1 text-xs text-[color:var(--tx3)]">{caption}</div>
    ) : null}
  </button>
)

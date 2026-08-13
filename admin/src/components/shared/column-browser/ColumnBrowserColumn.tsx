import type { ReactNode } from 'react'
import { PhoneBackButton } from '../../../layouts/admin-shell/PhoneBackButton'

type ColumnBrowserColumnProps = {
  children: ReactNode
  headerAction?: ReactNode
  leading?: ReactNode
  onBack?: () => void
  showBack?: boolean
  title: string
}

export const ColumnBrowserColumn = ({
  children,
  headerAction,
  leading,
  onBack,
  showBack,
  title,
}: ColumnBrowserColumnProps) => (
  <div className="flex h-full flex-col border-r border-[color:var(--sep)] bg-[color:var(--main)]">
    <div className="flex h-[50px] flex-shrink-0 items-center gap-2 border-b border-[color:var(--sep)] px-4">
      {leading}
      {showBack && onBack ? (
        <PhoneBackButton label={`Back to previous column from ${title}`} onBack={onBack} variant="labelled" />
      ) : null}
      <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-[color:var(--tx)]">
        {title}
      </h3>
      {headerAction}
    </div>
    <div className="flex-1 overflow-y-auto p-3">{children}</div>
  </div>
)

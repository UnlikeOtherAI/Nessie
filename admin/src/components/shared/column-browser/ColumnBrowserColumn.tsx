import type { ReactNode } from 'react'

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
        <button
          className="flex h-7 w-7 items-center justify-center rounded text-[color:var(--tx2)] hover:bg-[color:var(--overlay)]"
          onClick={onBack}
          type="button"
        >
          <svg
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            viewBox="0 0 24 24"
          >
            <path
              d="M15 19l-7-7 7-7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      ) : null}
      <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-[color:var(--tx)]">
        {title}
      </h3>
      {headerAction}
    </div>
    <div className="flex-1 overflow-y-auto p-3">{children}</div>
  </div>
)

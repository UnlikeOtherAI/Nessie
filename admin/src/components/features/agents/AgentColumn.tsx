import type { ReactNode } from 'react'

type AgentColumnProps = {
  children: ReactNode
  onBack?: () => void
  showBack?: boolean
  title: string
}

export const AgentColumn = ({ children, onBack, showBack, title }: AgentColumnProps) => (
  <div className="flex h-full flex-col border-r border-[color:var(--sep)] bg-[color:var(--main)]">
    <div className="flex h-[50px] flex-shrink-0 items-center gap-2 border-b border-[color:var(--sep)] px-4">
      {showBack && onBack ? (
        <button
          className="flex h-7 w-7 items-center justify-center rounded text-[color:var(--tx2)] hover:bg-white/10"
          onClick={onBack}
          type="button"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path d="M15 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      ) : null}
      <h3 className="truncate text-sm font-semibold text-white">{title}</h3>
    </div>
    <div className="flex-1 overflow-y-auto p-2">{children}</div>
  </div>
)

import type { ReactNode } from 'react'

type KnowledgePaneProps = {
  actions?: ReactNode
  children: ReactNode
  onBack?: () => void
  title: string
}

// Full-width chrome for the knowledge main area: a 50px header with an optional
// back button, the title, and right-aligned actions, over a scrollable body.
export const KnowledgePane = ({ actions, children, onBack, title }: KnowledgePaneProps) => (
  <div className="flex h-full flex-col bg-[color:var(--main)]">
    <div className="flex h-[50px] flex-shrink-0 items-center gap-3 border-b border-[color:var(--sep)] px-4">
      {onBack ? (
        <button
          className={[
            'flex h-8 flex-shrink-0 items-center gap-1.5 rounded-md pl-1.5 pr-2.5 text-sm',
            'text-[color:var(--tx2)] hover:bg-[color:var(--overlay)] hover:text-[var(--tx)]',
          ].join(' ')}
          onClick={onBack}
          type="button"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path d="M15 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Back
        </button>
      ) : null}
      <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-[color:var(--tx)]">{title}</h2>
      {actions ? <div className="flex flex-shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
  </div>
)

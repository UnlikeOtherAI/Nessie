import type { ReactNode } from 'react'
import { Avatar } from '../primitives/Avatar'

type AgentRowProps = {
  action?: ReactNode
  currentTask?: string
  footer?: string
  onClick?: () => void
  statusDot: ReactNode
  subtitle: string
  title: string
}

export const AgentRow = ({
  action,
  currentTask,
  footer,
  onClick,
  statusDot,
  subtitle,
  title,
}: AgentRowProps) => {
  const content = (
    <>
      <div className="flex items-start gap-3">
        <Avatar label={title} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="truncate font-medium">{title}</div>
            {statusDot}
          </div>
          <div className="mt-1 text-xs uppercase tracking-[0.16em] text-[color:var(--muted)]">
            {subtitle}
          </div>
          {currentTask ? (
            <div className="mt-2 text-xs leading-5 text-[color:var(--muted)]">{currentTask}</div>
          ) : null}
          {footer ? (
            <div className="mt-2 text-[11px] uppercase tracking-[0.16em] text-[color:var(--muted)]">
              {footer}
            </div>
          ) : null}
        </div>
      </div>
      {action}
    </>
  )

  const className =
    'w-full rounded-[1.35rem] border border-[color:var(--line)] bg-white/75 p-4 text-left transition hover:bg-white'

  return onClick ? (
    <button className={className} onClick={onClick} type="button">
      {content}
    </button>
  ) : (
    <div className={className}>{content}</div>
  )
}

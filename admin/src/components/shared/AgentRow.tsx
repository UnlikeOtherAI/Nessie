import type { ReactNode } from 'react'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { AgentAvatar } from './AgentAvatar'

type AgentRowProps = {
  action?: ReactNode
  /** Resolves the agent's portrait through the identity directory. */
  agentId?: string
  currentTask?: string
  footer?: string
  onClick?: () => void
  statusDot: ReactNode
  subtitle: string
  title: string
}

export const AgentRow = ({
  action,
  agentId,
  currentTask,
  footer,
  onClick,
  statusDot,
  subtitle,
  title,
}: AgentRowProps) => {
  const { token } = useAuthSession()
  const content = (
    <>
      <div className="flex items-start gap-3">
        <AgentAvatar agent={{ id: agentId ?? '', name: title, role: subtitle }} agentId={agentId} size={32} token={token} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="truncate font-medium text-[color:var(--tx)]">{title}</div>
            {statusDot}
          </div>
          <div className="mt-1 text-xs uppercase tracking-[0.16em] text-[color:var(--tx3)]">
            {subtitle}
          </div>
          {currentTask ? (
            <div className="mt-2 text-xs leading-5 text-[color:var(--tx2)]">
              {currentTask}
            </div>
          ) : null}
          {footer ? (
            <div className="mt-2 text-[11px] uppercase tracking-[0.16em] text-[color:var(--tx3)]">
              {footer}
            </div>
          ) : null}
        </div>
      </div>
      {action}
    </>
  )

  const className = [
    'w-full rounded-xl border border-[color:var(--sep)]',
    'bg-[color:var(--panel)] p-4 text-left transition',
    'hover:bg-[color:var(--main-hover)]',
  ].join(' ')

  return onClick ? (
    <button className={className} onClick={onClick} type="button">
      {content}
    </button>
  ) : (
    <div className={className}>{content}</div>
  )
}

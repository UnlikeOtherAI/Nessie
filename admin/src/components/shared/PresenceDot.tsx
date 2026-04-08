type PresenceDotProps = {
  status: 'connected' | 'disconnected' | 'error' | 'executing' | 'idle' | 'offline' | 'thinking' | 'waiting_approval'
}

const dotClass = (status: PresenceDotProps['status']): string => {
  if (status === 'executing') return 'bg-[color:var(--executing)] status-pulse'
  if (status === 'thinking') return 'bg-[color:var(--thinking)] status-pulse'
  if (status === 'waiting_approval') return 'bg-[color:var(--warning)]'
  if (status === 'connected') return 'bg-[color:var(--accent)]'
  if (status === 'error') return 'bg-[color:var(--danger)]'
  if (status === 'offline' || status === 'disconnected') return 'bg-slate-300'
  return 'bg-[color:var(--muted)]'
}

export const PresenceDot = ({ status }: PresenceDotProps) => (
  <span className={`inline-flex h-3 w-3 rounded-full ${dotClass(status)}`} />
)

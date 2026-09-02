type AgentStatus =
  | 'error'
  | 'executing'
  | 'idle'
  | 'offline'
  | 'thinking'
  | 'waiting_approval'
  | 'waiting_input'

type AgentStatusDotProps = {
  status: AgentStatus
}

const statusClasses: Record<AgentStatus, string> = {
  error: 'bg-[color:var(--danger)]',
  executing: 'bg-[color:var(--executing)] status-pulse',
  idle: 'bg-[color:var(--muted)]/45',
  offline: 'bg-[color:var(--muted)]/25',
  thinking: 'bg-[color:var(--thinking)] status-pulse',
  waiting_approval: 'bg-[color:var(--warning)]',
  waiting_input: 'bg-[color:var(--warning)]',
}

export const AgentStatusDot = ({ status }: AgentStatusDotProps) => (
  <span aria-hidden="true" className={`inline-flex h-3 w-3 rounded-full ${statusClasses[status]}`} />
)

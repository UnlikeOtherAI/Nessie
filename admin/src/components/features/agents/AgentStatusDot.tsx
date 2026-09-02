import type { AgentStatus } from '@nessie/schemas'
import { agentStatusDotClass } from './agent-presentation'

type AgentStatusDotProps = {
  status: AgentStatus
}

export const AgentStatusDot = ({ status }: AgentStatusDotProps) => (
  <span aria-hidden="true" className={`inline-flex h-3 w-3 rounded-full ${agentStatusDotClass[status]}`} />
)

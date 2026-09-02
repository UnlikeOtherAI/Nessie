import type { ReactNode } from 'react'
import { useAgentStatus } from '../../../facades/agents/hooks'
import type { AgentRecord } from '../../../lib/api-client'
import { Pill } from '../../primitives/Pill'
import { AgentAvatarQuickEdit } from './AgentAvatarQuickEdit'
import { AgentStatusDot } from './AgentStatusDot'
import { agentStatusTone } from './agent-presentation'

type AgentIdentityBlockProps = {
  agent: AgentRecord
  avatarSize?: 'lg' | 'xl'
  canEditAvatar: boolean
  /** Extra content under the role line — the detail page's private-home link. */
  children?: ReactNode
  /** The page's own heading vs. a panel's, for correct document structure. */
  headingLevel?: 'h1' | 'h2'
}

/**
 * Avatar + name + status dot + status `Pill` + role + activity line — the
 * agent's identity, written out once. It was duplicated almost verbatim
 * between `AgentDetailPage`'s header and `AgentDetailDrawer`'s header,
 * including its own copy of the status→tone mapping.
 *
 * Renders only the avatar and the text column, not the surrounding flex row —
 * the page header and the drawer header lay that row out differently (a back
 * button beside it here, close/edit buttons there), and that layout stays
 * with each caller.
 */
export const AgentIdentityBlock = ({
  agent,
  avatarSize = 'lg',
  canEditAvatar,
  children,
  headingLevel = 'h2',
}: AgentIdentityBlockProps) => {
  const { data: status } = useAgentStatus(agent.id)
  const Heading = headingLevel

  return (
    <>
      <AgentAvatarQuickEdit agent={agent} canEdit={canEditAvatar} size={avatarSize} />
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <Heading className="truncate text-2xl font-semibold text-[color:var(--tx)]">
            {agent.name}
          </Heading>
          <AgentStatusDot status={agent.status} />
          <Pill tone={agentStatusTone(agent.status)}>{agent.status}</Pill>
        </div>
        <div className="truncate text-sm text-[color:var(--tx2)]">{agent.role}</div>
        {children}
        <div className="mt-0.5 text-xs uppercase tracking-[0.16em] text-[color:var(--tx3)]">
          {status?.currentToolName
            ? `Active tool: ${status.currentToolName}`
            : `Last activity ${new Date(agent.lastActivityAt).toLocaleString()}`}
        </div>
      </div>
    </>
  )
}

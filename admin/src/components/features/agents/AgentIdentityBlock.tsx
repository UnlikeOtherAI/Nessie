import type { ReactNode } from 'react'
import { useAgentStatus } from '../../../facades/agents/hooks'
import type { AgentRecord } from '../../../lib/api-client'
import { Pill } from '../../primitives/Pill'
import { AgentAvatarQuickEdit } from './AgentAvatarQuickEdit'
import { AgentStatusDot } from './AgentStatusDot'
import { agentStatusTone } from './agent-presentation'

type AgentIdentityBlockProps = {
  agent: AgentRecord
  /**
   * Renders the avatar ahead of the text column. A caller whose own chrome
   * already places the avatar — `ScreenHeader`'s leading lane on the detail
   * page — passes false and keeps only the identity text.
   */
  avatar?: boolean
  avatarSize?: 'lg' | 'xl'
  canEditAvatar: boolean
  /** Extra content under the role line — the detail page's private-home link. */
  children?: ReactNode
  /**
   * The page's own heading vs. a panel's, for correct document structure.
   * `'none'` is for a caller whose screen header already renders the one `h1`
   * (docs/navigation/overview.md §9): a second heading here would be the second `h1`
   * the settle and the live region cannot choose between.
   */
  headingLevel?: 'h1' | 'h2' | 'none'
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
  avatar = true,
  avatarSize = 'lg',
  canEditAvatar,
  children,
  headingLevel = 'h2',
}: AgentIdentityBlockProps) => {
  // A Nessie-managed agent's live status is one of the closed operational
  // reads (`isAgentAccessibleToActor` hard-codes `systemManaged: false`), so
  // asking for it can only 404. Passing no id leaves the query idle; the dot,
  // the pill and the last-activity line all come off the record anyway.
  const { data: status } = useAgentStatus(agent.systemManaged === true ? undefined : agent.id)
  const Heading = headingLevel === 'none' ? null : headingLevel

  return (
    <>
      {avatar ? (
        <AgentAvatarQuickEdit agent={agent} canEdit={canEditAvatar} size={avatarSize} />
      ) : null}
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          {Heading ? (
            <Heading className="truncate text-2xl font-semibold text-[color:var(--tx)]">
              {agent.name}
            </Heading>
          ) : null}
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

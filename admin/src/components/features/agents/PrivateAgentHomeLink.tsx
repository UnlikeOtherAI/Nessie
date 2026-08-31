import type { SyntheticEvent } from 'react'
import { Link } from 'react-router-dom'
import type { AgentRecord } from '../../../lib/api-client'

/**
 * A private agent has one working surface: the owner-only DM created with it.
 * The list projection already includes that sole binding, so no second lookup
 * or client-side visibility rule is needed to make the doorway reachable.
 */
export const privateAgentHomeChannelId = (agent: AgentRecord): string | undefined =>
  agent.visibility === 'private'
    ? agent.homeChannelId ?? agent.channelIds[0]
    : undefined

type PrivateAgentHomeLinkProps = {
  agent: AgentRecord
  className?: string
  stopParentNavigation?: boolean
}

export const PrivateAgentHomeLink = ({
  agent,
  className,
  stopParentNavigation = false,
}: PrivateAgentHomeLinkProps) => {
  const channelId = privateAgentHomeChannelId(agent)
  if (!channelId) return null

  const stopPropagation = (event: SyntheticEvent<HTMLAnchorElement>) => {
    if (stopParentNavigation) event.stopPropagation()
  }

  return (
    <Link
      className={className ?? 'text-xs text-[color:var(--lnk)] hover:underline'}
      onClick={stopPropagation}
      onKeyDown={stopPropagation}
      to={`/channels/${channelId}`}
    >
      Open private home
    </Link>
  )
}

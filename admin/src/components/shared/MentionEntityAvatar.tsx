import { IdentityTile } from '../primitives/IdentityTile'
import { UserAvatar } from '../primitives/UserAvatar'
import { AgentAvatar } from './AgentAvatar'
import type { MentionEntity } from './MentionInput'
import { useAuthSession } from '../../providers/AuthSessionProvider'

/**
 * The picture beside a mention suggestion. A user and an agent both carry a
 * real id here, so both resolve their actual portrait; only a channel is a
 * type rather than an identity and keeps its `#`.
 */
export const MentionEntityAvatar = ({ entity }: { entity: MentionEntity }) => {
  const { token } = useAuthSession()

  if (entity.type === 'channel') {
    return (
      <IdentityTile
        background="var(--overlay)"
        color="var(--tx2)"
        fallback={{ kind: 'glyph', glyph: '#' }}
        imageUrl={null}
        label={entity.name}
        size={24}
      />
    )
  }
  if (entity.type === 'agent') {
    return (
      <AgentAvatar
        agent={{ id: entity.id, name: entity.name, role: '' }}
        agentId={entity.id}
        size={24}
        token={token}
      />
    )
  }
  return <UserAvatar displayName={entity.name} size={24} token={token} userId={entity.id} />
}

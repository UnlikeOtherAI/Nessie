import type { AgentRecord } from '../../../lib/api-client'
import { AgentAvatar, type AgentAvatarSource } from '../../shared/AgentAvatar'

type ChannelAgentGlyphProps = {
  agent?: AgentAvatarSource | AgentRecord | null
  size?: 'md' | 'lg'
  token: string | null
}

export const ChannelAgentGlyph = ({
  agent,
  size = 'md',
  token,
}: ChannelAgentGlyphProps) => (
  <AgentAvatar agent={agent} size={size} token={token} />
)

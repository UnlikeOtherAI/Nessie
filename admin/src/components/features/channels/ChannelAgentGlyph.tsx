import type { AgentRecord } from '../../../lib/api-client'
import { AgentAvatar } from '../../shared/AgentAvatar'

type ChannelAgentGlyphProps = {
  agent?: AgentRecord | null
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

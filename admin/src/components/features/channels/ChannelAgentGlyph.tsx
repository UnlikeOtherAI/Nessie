import type { AgentRecord } from '../../../lib/api-client'
import { getAgentGlyph } from './channel-helpers'

type ChannelAgentGlyphProps = {
  agent?: AgentRecord | null
  size?: 'md' | 'lg'
}

export const ChannelAgentGlyph = ({
  agent,
  size = 'md',
}: ChannelAgentGlyphProps) => (
  <div
    className={[
      'flex flex-shrink-0 items-center justify-center',
      'rounded-lg border border-[var(--accent)]',
      'bg-[var(--accent-soft)] text-lg',
      size === 'lg' ? 'h-[46px] w-[46px] text-xl' : 'h-9 w-9',
    ].join(' ')}
  >
    {getAgentGlyph(agent)}
  </div>
)

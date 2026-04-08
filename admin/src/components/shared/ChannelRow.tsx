import type { ChannelRecord } from '../../lib/api-client'
import { UnreadBadge } from '../primitives/UnreadBadge'

type ChannelRowProps = {
  active?: boolean
  channel: ChannelRecord
  onClick: () => void
  unreadCount?: number
}

export const ChannelRow = ({ active = false, channel, onClick, unreadCount = 0 }: ChannelRowProps) => (
  <button
    className={`flex w-full items-center justify-between rounded-[1.35rem] border px-4 py-3 text-left transition ${
      active
        ? 'border-[color:var(--accent)] bg-[color:var(--accent-soft)]'
        : 'border-[color:var(--line)] bg-white/75 hover:bg-white'
    }`}
    onClick={onClick}
    type="button"
  >
    <div className="min-w-0">
      <div className="truncate font-medium">{channel.label}</div>
      <div className="mt-1 text-xs uppercase tracking-[0.16em] text-[color:var(--muted)]">
        {channel.visibility}
      </div>
    </div>
    <UnreadBadge value={unreadCount} />
  </button>
)

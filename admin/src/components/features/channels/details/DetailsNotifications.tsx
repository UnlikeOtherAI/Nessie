import { useSetChannelMute } from '../../../../facades/channels/hooks'
import type { ChannelRecord } from '../../../../lib/api-client'
import { FormError } from '../../../shared/FormActions'
import { isRoom } from './details-sections'

/**
 * Details › Notifications: mute this conversation, for this reader only.
 * Muting stops push notifications and never the alert row an @mention writes
 * (docs/standards/user-alerts.md), and it is a membership setting — the route
 * answers somebody who has not joined a room with 404 — so a reader outside a
 * room sees the switch disabled and is told how to get it.
 */
export const DetailsNotifications = ({ channel }: { channel: ChannelRecord }) => {
  const setMute = useSetChannelMute()
  const member = !isRoom(channel) || channel.viewerIsMember === true
  const muted = channel.muted === true

  return (
    <div className="grid gap-3">
      <label className="flex items-start gap-3">
        <input
          checked={muted}
          className="mt-1"
          disabled={!member || setMute.isPending}
          onChange={() => setMute.mutate({ channelId: channel.id, muted: !muted })}
          type="checkbox"
        />
        <span className="grid gap-0.5">
          <span className="text-sm font-semibold text-[color:var(--tx)]">Mute this conversation</span>
          <span className="text-sm text-[color:var(--tx2)]">
            {muted
              ? 'Muted: your devices are not notified about new messages here. Mentions of you still reach your alerts.'
              : 'You are notified about new messages here.'}
          </span>
        </span>
      </label>
      {!member ? (
        <p className="text-sm text-[color:var(--tx3)]">Join this channel to choose its notifications.</p>
      ) : null}
      <FormError>{setMute.error ? setMute.error.message : undefined}</FormError>
    </div>
  )
}

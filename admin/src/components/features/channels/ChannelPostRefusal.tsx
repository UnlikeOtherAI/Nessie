import {
  WorkThreadReadOnlyNotice,
  type WorkThreadReadOnly,
} from '../ticket-work/WorkThreadReadOnlyNotice'
import type { ChannelRoomControls } from './channel-room-controls'

/**
 * What stands where the composer would, when the viewer may not write here —
 * and why. Two different rules can take the composer away:
 *
 * - **Membership** (`ChannelRoomControls.postRefusal`): the composer is
 *   membership, not management. An organisation admin administering a room
 *   they never joined reads it, opens its settings and its members popup, and
 *   cannot speak in it — decision 2 of the visibility spec. A public room the
 *   viewer has not joined offers Join in the header instead; a protected one
 *   offers neither.
 * - **A ticket's work thread** (docs/standards/ticket-work.md → "The work
 *   thread"): a member of the room who cannot edit the ticket's board reads
 *   the thread and is pointed at the ticket's comments instead.
 */
export const ChannelPostRefusal = ({
  postRefusal,
  workThreadReadOnly,
}: {
  postRefusal: ChannelRoomControls['postRefusal']
  workThreadReadOnly: WorkThreadReadOnly | null
}) => {
  if (postRefusal) {
    return (
      <div
        className="border-t border-[color:var(--bd)] px-4 py-3 text-xs text-[color:var(--tx3)]"
        role="status"
      >
        {postRefusal === 'join-to-post'
          ? 'Join this channel to send messages.'
          : 'You are not a member of this channel, so you cannot send messages in it.'}
      </div>
    )
  }
  return workThreadReadOnly ? <WorkThreadReadOnlyNotice {...workThreadReadOnly} /> : null
}

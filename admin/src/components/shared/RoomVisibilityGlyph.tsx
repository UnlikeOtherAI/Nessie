import { faLock } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'

/**
 * The one lock marker for a protected project or channel.
 *
 * **The lock is derived, never transmitted.** There is no `locked` field on the
 * wire: a room is drawn with a lock exactly when its `visibility` is
 * `protected`, and every surface asks that question here rather than each
 * re-deciding it. That matters because the answer appears in at least five
 * places — three sidebar sections, the channel header and the project
 * directory — and a marker that disagrees with itself between two of them
 * teaches people not to trust it.
 *
 * `private` deliberately draws NO lock. It is not a stronger version of
 * protected; it is the stored value for direct messages and system surfaces,
 * which are never rendered as rooms in the first place. A lock there would
 * imply a room somebody could ask to be let into.
 */

export type RoomVisibility = 'private' | 'protected' | 'public'

export const isProtectedRoom = (
  visibility: RoomVisibility | null | undefined,
): boolean => visibility === 'protected'

type ChannelGlyphProps = {
  className: string
  visibility: RoomVisibility | null | undefined
}

/**
 * The symbol that stands before a channel's name: `#` for an ordinary room, a
 * padlock for a protected one. It occupies the same box either way, so a list
 * of channels does not reflow when one of them is locked.
 */
export const ChannelGlyph = ({ className, visibility }: ChannelGlyphProps) =>
  isProtectedRoom(visibility) ? (
    <span aria-label="Protected channel" className={className} role="img" title="Protected — people outside it see only its name and members">
      <FontAwesomeIcon className="h-3 w-3" icon={faLock} />
    </span>
  ) : (
    <span className={className}>#</span>
  )

/**
 * The same marker beside a project's name, where there is no `#` to replace.
 * Renders nothing at all for a public project rather than an empty box: a
 * project row has no column reserved for it.
 */
export const ProjectLockMarker = ({
  visibility,
}: {
  visibility: RoomVisibility | null | undefined
}) =>
  isProtectedRoom(visibility) ? (
    <FontAwesomeIcon
      aria-label="Protected project"
      className="h-3 w-3 flex-shrink-0 text-[color:var(--tx3)]"
      icon={faLock}
      role="img"
      title="Protected — people outside it see only its name and members"
    />
  ) : null

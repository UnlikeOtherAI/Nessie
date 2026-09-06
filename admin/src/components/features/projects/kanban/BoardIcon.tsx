import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { BOARD_ICON } from '../../../../navigation/project-sections'

type BoardIconProps = {
  className?: string
  /** The board's own emoji, or null for the icon every board wears by default. */
  iconEmoji: string | null
  /** `sm` is the sidebar row; `md` is a control you click to change it. */
  size?: 'sm' | 'md'
}

const BOX = {
  sm: 'h-3.5 w-3.5 text-[13px]',
  md: 'h-5 w-5 text-[17px]',
} as const

/**
 * What a board looks like in a list.
 *
 * One component so a board wears the same glyph in the Projects sidebar, in
 * project settings and in the dialog that made it — and so the fallback for a
 * board with no emoji of its own is decided in exactly one place. The box is a
 * fixed square either way, so a list of boards where only some carry an emoji
 * still has its names in a straight line.
 */
export const BoardIcon = ({ className, iconEmoji, size = 'sm' }: BoardIconProps) => (
  <span
    aria-hidden="true"
    className={[
      'inline-flex flex-shrink-0 items-center justify-center leading-none',
      BOX[size],
      className,
    ].filter(Boolean).join(' ')}
  >
    {iconEmoji ?? <FontAwesomeIcon className="h-full w-full" fixedWidth icon={BOARD_ICON} />}
  </span>
)

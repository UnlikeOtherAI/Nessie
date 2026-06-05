/** Inline iconography used across the channel-members popup. */

type IconProps = { className?: string }

export const CloseIcon = ({ className = 'h-4 w-4' }: IconProps) => (
  <svg
    className={className}
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    viewBox="0 0 24 24"
  >
    <path
      d="M6 18L18 6M6 6l12 12"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

export const SearchIcon = ({
  className = 'h-4 w-4 flex-shrink-0 text-[color:var(--tx3)]',
}: IconProps) => (
  <svg
    className={className}
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    viewBox="0 0 24 24"
  >
    <path
      d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

export const CloneIcon = ({ className = 'h-3.5 w-3.5' }: IconProps) => (
  <svg
    className={className}
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    viewBox="0 0 24 24"
  >
    <rect height="13" rx="2" width="13" x="9" y="9" />
    <path
      d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

export const ViewIcon = ({ className = 'h-3.5 w-3.5' }: IconProps) => (
  <svg
    className={className}
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    viewBox="0 0 24 24"
  >
    <path
      d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d={[
        'M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943',
        '9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943',
        '-9.542-7z',
      ].join(' ')}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

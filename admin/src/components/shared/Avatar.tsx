type AvatarProps = {
  label: string
}

const initialsFromLabel = (label: string): string =>
  label
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')

export const Avatar = ({ label }: AvatarProps) => (
  <div
    className={[
      'flex h-10 w-10 items-center justify-center rounded-2xl',
      'bg-[color:var(--accent-soft)] text-xs',
      'font-semibold uppercase',
      'tracking-[0.24em] text-[color:var(--accent)]',
    ].join(' ')}
  >
    {initialsFromLabel(label)}
  </div>
)

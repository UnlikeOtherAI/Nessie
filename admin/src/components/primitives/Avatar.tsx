import { getInitials } from '../../lib/avatar'

type AvatarProps = {
  label: string
  size?: 'md' | 'sm'
}

const sizeClasses = {
  md: 'h-10 w-10 text-sm',
  sm: 'h-8 w-8 text-xs',
} as const

export const Avatar = ({ label, size = 'md' }: AvatarProps) => (
  <div
    aria-hidden="true"
    className={[
      'inline-flex items-center justify-center rounded-md',
      'bg-[color:var(--accent-soft)] font-semibold',
      'text-[color:var(--accent)]',
      sizeClasses[size],
    ].join(' ')}
  >
    {getInitials(label)}
  </div>
)

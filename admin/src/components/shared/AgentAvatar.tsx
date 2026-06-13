import type { AgentRecord } from '../../lib/api-client'
import { useAuthedObjectUrl } from '../../lib/uploads'

type AgentAvatarSource = Pick<AgentRecord, 'avatarAttachmentId' | 'name' | 'role'>

type AgentAvatarProps = {
  agent?: AgentAvatarSource | null
  className?: string
  muted?: boolean
  shape?: 'circle' | 'rounded'
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
  token: string | null
}

const sizePx: Record<NonNullable<AgentAvatarProps['size']>, number> = {
  xs: 24,
  sm: 32,
  md: 36,
  lg: 46,
  xl: 96,
}

const glyphSizeClass: Record<NonNullable<AgentAvatarProps['size']>, string> = {
  xs: 'text-[10px]',
  sm: 'text-sm',
  md: 'text-lg',
  lg: 'text-xl',
  xl: 'text-4xl',
}

export const getAgentGlyph = (agent?: Pick<AgentAvatarSource, 'role'> | null): string => {
  if (!agent) {
    return '⚡'
  }

  const role = agent.role.toLowerCase()
  if (role.includes('research')) {
    return '🔍'
  }
  if (role.includes('write')) {
    return '📝'
  }
  return '⚡'
}

export const AgentAvatar = ({
  agent,
  className = '',
  muted = false,
  shape = 'rounded',
  size = 'md',
  token,
}: AgentAvatarProps) => {
  const objectUrl = useAuthedObjectUrl(agent?.avatarAttachmentId ?? null, token)
  const dimension = sizePx[size]
  const shapeClass = shape === 'circle' ? 'rounded-full' : 'rounded-lg'
  const classes = [
    'flex flex-shrink-0 items-center justify-center overflow-hidden',
    shapeClass,
    muted ? 'opacity-60' : '',
    className,
  ].join(' ')

  if (objectUrl) {
    return (
      <img
        alt={agent?.name ? `${agent.name} avatar` : 'Agent avatar'}
        className={`${classes} object-cover`}
        height={dimension}
        src={objectUrl}
        style={{ height: dimension, width: dimension }}
        width={dimension}
      />
    )
  }

  return (
    <div
      aria-hidden="true"
      className={[
        classes,
        'border border-[var(--accent)] bg-[var(--accent-soft)]',
        glyphSizeClass[size],
      ].join(' ')}
      style={{ height: dimension, width: dimension }}
    >
      {getAgentGlyph(agent)}
    </div>
  )
}

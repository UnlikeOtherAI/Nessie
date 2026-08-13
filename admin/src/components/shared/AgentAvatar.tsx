import type { AgentRecord } from '../../lib/api-client'
import { AGENT_AVATAR_BACKGROUND_COLORS } from '@nessie/schemas'
import { useAuthedObjectUrl } from '../../lib/uploads'

type AgentAvatarSource = Pick<
  AgentRecord,
  'avatarAttachmentId' | 'avatarBackgroundColor' | 'id' | 'name' | 'role'
>

type AgentAvatarProps = {
  agent?: AgentAvatarSource | null
  className?: string
  muted?: boolean
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

const fallbackBackgroundColor = (agent?: Pick<AgentAvatarSource, 'id'> | null): string => {
  const identifier = agent?.id ?? ''
  const hash = [...identifier].reduce(
    (value, character) => (value * 31 + character.charCodeAt(0)) >>> 0,
    0,
  )
  return AGENT_AVATAR_BACKGROUND_COLORS[
    hash % AGENT_AVATAR_BACKGROUND_COLORS.length
  ]!
}

export const AgentAvatar = ({
  agent,
  className = '',
  muted = false,
  size = 'md',
  token,
}: AgentAvatarProps) => {
  const objectUrl = useAuthedObjectUrl(agent?.avatarAttachmentId ?? null, token)
  const dimension = sizePx[size]
  const backgroundColor = agent?.avatarBackgroundColor ?? fallbackBackgroundColor(agent)
  const classes = [
    'flex flex-shrink-0 items-center justify-center overflow-hidden',
    'rounded-md',
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
        style={{ backgroundColor, height: dimension, width: dimension }}
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
      style={{ backgroundColor, height: dimension, width: dimension }}
    >
      {getAgentGlyph(agent)}
    </div>
  )
}

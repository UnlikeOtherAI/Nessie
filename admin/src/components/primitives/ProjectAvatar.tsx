import { useEffect, useState } from 'react'

import { getInitials } from '../../lib/avatar'
import { useAuthedObjectUrl } from '../../lib/uploads'

type ProjectAvatarProps = {
  avatarAttachmentId?: string | null
  avatarEmoji?: string | null
  className?: string
  name: string
  size?: number
  token: string | null
}

/** A project identity uses the same rounded-square treatment as a profile photo. */
export const ProjectAvatar = ({
  avatarAttachmentId,
  avatarEmoji,
  className,
  name,
  size = 32,
  token,
}: ProjectAvatarProps) => {
  const imageUrl = useAuthedObjectUrl(avatarAttachmentId ?? null, token)
  const [broken, setBroken] = useState(false)

  useEffect(() => setBroken(false), [imageUrl])

  return (
    <span
      aria-hidden="true"
      className={[
        'flex shrink-0 items-center justify-center overflow-hidden rounded-md',
        'bg-[color:var(--accent)] font-bold text-[color:var(--on-accent)]',
        className ?? '',
      ].join(' ')}
      style={{ fontSize: Math.round(size * 0.48), height: size, width: size }}
    >
      {imageUrl && !broken ? (
        <img alt="" className="h-full w-full object-cover" onError={() => setBroken(true)} src={imageUrl} />
      ) : avatarEmoji ? (
        <span>{avatarEmoji}</span>
      ) : (
        <span>{getInitials(name, 'P')}</span>
      )}
    </span>
  )
}

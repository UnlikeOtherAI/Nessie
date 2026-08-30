import { useEffect, useState } from 'react'

import { useAuthedObjectUrl } from '../../lib/uploads'

type ProjectAvatarProps = {
  avatarAttachmentId?: string | null
  avatarEmoji?: string | null
  className?: string
  size?: number
  token: string | null
}

/** Shows a project picture when set, otherwise its neutral folder marker. */
export const ProjectAvatar = ({
  avatarAttachmentId,
  avatarEmoji,
  className,
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
        className ?? '',
      ].join(' ')}
      style={{ height: size, width: size }}
    >
      {imageUrl && !broken ? (
        <img alt="" className="h-full w-full object-cover" onError={() => setBroken(true)} src={imageUrl} />
      ) : avatarEmoji ? (
        <span style={{ fontSize: Math.round(size * 0.48) }}>{avatarEmoji}</span>
      ) : (
        <svg
          className="shrink-0 text-[color:var(--tx3)]"
          fill="none"
          height={Math.round(size * 0.72)}
          stroke="currentColor"
          strokeWidth="1.8"
          viewBox="0 0 24 24"
          width={Math.round(size * 0.72)}
        >
          <path
            d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </span>
  )
}

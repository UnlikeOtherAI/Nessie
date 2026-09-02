import { useAuthedObjectUrl } from '../../lib/uploads'
import { IdentityTile } from './IdentityTile'

type ProjectAvatarProps = {
  avatarAttachmentId?: string | null
  avatarEmoji?: string | null
  className?: string
  size?: number
  token: string | null
}

const FolderMark = ({ size }: { size: number }) => (
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
)

/** Shows a project picture when set, otherwise its emoji or folder marker. */
export const ProjectAvatar = ({
  avatarAttachmentId,
  avatarEmoji,
  className,
  size = 32,
  token,
}: ProjectAvatarProps) => {
  const imageUrl = useAuthedObjectUrl(avatarAttachmentId ?? null, token)

  return (
    <IdentityTile
      className={className}
      fallback={
        avatarEmoji
          ? { kind: 'glyph', glyph: avatarEmoji }
          : { kind: 'icon', icon: <FolderMark size={size} /> }
      }
      imageUrl={avatarAttachmentId ? imageUrl : null}
      label=""
      size={size}
    />
  )
}

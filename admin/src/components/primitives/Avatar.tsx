import { IdentityTile } from './IdentityTile'
import { identityInitials } from './identity-shape'

type AvatarProps = {
  label: string
  size?: 'md' | 'sm' | number
}

const NAMED_SIZES = { md: 40, sm: 32 } as const

/**
 * An initials tile for an identity with no picture to resolve. Anything that
 * *can* have a picture uses `UserAvatar` / `AgentAvatar` / `ProjectAvatar` /
 * `WorkspaceAvatar` instead — this is the degenerate case, not a shortcut.
 */
export const Avatar = ({ label, size = 'md' }: AvatarProps) => (
  <IdentityTile
    background="var(--accent-soft)"
    color="var(--accent)"
    fallback={{ kind: 'initials', text: identityInitials(label) }}
    imageUrl={null}
    label={label}
    size={typeof size === 'number' ? size : NAMED_SIZES[size]}
  />
)

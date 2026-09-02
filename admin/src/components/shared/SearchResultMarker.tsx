import type { ProjectRecord, UserRecord } from '../../lib/api-client'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { IdentityTile } from '../primitives/IdentityTile'
import { ProjectAvatar } from '../primitives/ProjectAvatar'
import { UserAvatar } from '../primitives/UserAvatar'

/** What a search hit is, for the purpose of the tile in front of it. */
export type SearchMarkerSubject =
  | { kind: 'person'; user: UserRecord; displayName: string }
  | { kind: 'project'; project: ProjectRecord }
  | { kind: 'channel' }
  | { kind: 'message' }
  | { kind: 'knowledge' }
  | { kind: 'thought' }

const TYPE_GLYPH: Record<'channel' | 'message' | 'knowledge' | 'thought', string> = {
  channel: '#',
  message: '💬',
  knowledge: '📄',
  thought: 'M',
}

/**
 * The tile in front of a search hit, shared by the top-bar suggestions and the
 * full search page.
 *
 * A hit that names a *person* or a *project* shows that person's or project's
 * real picture — both surfaces already carry the whole record and were drawing
 * its first letter instead. Everything else is a result *type*, not an
 * identity, and keeps a glyph; it sits on the same tile so a mixed result list
 * has one column of one shape rather than two sizes at two radii.
 */
export const SearchResultMarker = ({
  size = 28,
  subject,
}: {
  size?: number
  subject: SearchMarkerSubject
}) => {
  const { token } = useAuthSession()

  if (subject.kind === 'person') {
    return (
      <UserAvatar
        avatarAttachmentId={subject.user.avatarAttachmentId ?? undefined}
        avatarUrl={subject.user.avatarUrl ?? undefined}
        displayName={subject.displayName}
        size={size}
        token={token}
        userId={subject.user.id}
      />
    )
  }

  if (subject.kind === 'project') {
    return (
      <ProjectAvatar
        avatarAttachmentId={subject.project.avatarAttachmentId}
        avatarEmoji={subject.project.avatarEmoji}
        size={size}
        token={token}
      />
    )
  }

  return (
    <IdentityTile
      background="var(--overlay-weak)"
      color="var(--tx2)"
      fallback={{ kind: 'glyph', glyph: TYPE_GLYPH[subject.kind] }}
      imageUrl={null}
      label=""
      size={size}
    />
  )
}

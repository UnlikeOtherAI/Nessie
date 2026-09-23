import type { AgentRecord, AppSummaryRecord, ProjectRecord } from '@nessie/schemas'
import type { UserRecord } from '../../../lib/api-client'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { AppIcon } from '../apps/AppIcon'
import { IdentityTile } from '../../primitives/IdentityTile'
import { ProjectAvatar } from '../../primitives/ProjectAvatar'
import { AgentAvatar } from '../../shared/AgentAvatar'
import { isProtectedRoom, type RoomVisibility } from '../../shared/RoomVisibilityGlyph'
import { UserAvatar } from '../../shared/UserAvatar'

/** What a search hit is, for the purpose of the tile in front of it. */
export type SearchMarkerSubject =
  | { kind: 'agent'; agent: AgentRecord }
  | { kind: 'app'; app: AppSummaryRecord }
  | { kind: 'person'; user: UserRecord; displayName: string }
  | { kind: 'project'; project: ProjectRecord | null; visibility?: RoomVisibility }
  | { kind: 'channel'; visibility?: RoomVisibility }
  | { kind: 'message' }
  | { kind: 'knowledge' }
  | { kind: 'thought' }
  | { kind: 'task' }

const TYPE_GLYPH: Record<'message' | 'knowledge' | 'thought' | 'task', string> = {
  message: '💬',
  knowledge: '📄',
  thought: 'M',
  task: '✓',
}

/** One identity-or-type tile for both global-search surfaces. */
export const SearchResultMarker = ({
  size = 28,
  subject,
}: {
  size?: number
  subject: SearchMarkerSubject
}) => {
  const { token } = useAuthSession()

  if (subject.kind === 'agent') {
    return <AgentAvatar agent={subject.agent} size={size} token={token} />
  }

  if (subject.kind === 'app') {
    return (
      <AppIcon
        displayName={subject.app.displayName}
        iconUrl={subject.app.iconUrl}
        size={size}
      />
    )
  }

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

  if (subject.kind === 'project' && subject.project) {
    return (
      <ProjectAvatar
        avatarAttachmentId={subject.project.avatarAttachmentId}
        avatarEmoji={subject.project.avatarEmoji}
        size={size}
        token={token}
      />
    )
  }

  const fallback = subject.kind === 'channel'
    ? isProtectedRoom(subject.visibility) ? '🔒' : '#'
    : subject.kind === 'project'
      ? isProtectedRoom(subject.visibility) ? '🔒' : 'P'
      : TYPE_GLYPH[subject.kind]

  return (
    <IdentityTile
      background="var(--overlay-weak)"
      color="var(--tx2)"
      fallback={{ kind: 'glyph', glyph: fallback }}
      imageUrl={null}
      label=""
      size={size}
    />
  )
}

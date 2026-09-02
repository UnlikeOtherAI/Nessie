import { useNavigateToDm } from '../../../facades/channels/dm-navigation'
import { useProjectMembers } from '../../../facades/projects/hooks'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { UserAvatar } from '../../primitives/UserAvatar'
import { useIsOwner } from '../../shared/OwnerGate'
import { Skeleton } from '../../primitives/Skeleton'
import {
  DashboardSectionCard,
  SectionNotice,
  SectionOverflowHint,
  dashboardRowClass,
  type SectionLink,
} from './DashboardSectionCard'
import {
  MEMBER_ROW_CAP,
  canManageProjectMembers,
  orderProjectMembers,
} from './project-dashboard-data'

type ProjectMembersSectionProps = {
  className?: string
  projectId: string
}

/**
 * Who is here and who to ping. Rows open the DM through the one shared
 * `useNavigateToDm`, which works for members as well as owners.
 */
export const ProjectMembersSection = ({ className, projectId }: ProjectMembersSectionProps) => {
  const { me, token } = useAuthSession()
  const isOrganizationOwner = useIsOwner()
  const navigateToDm = useNavigateToDm()
  const { data: members, isError, isPending } = useProjectMembers(projectId)

  const ordered = orderProjectMembers(members ?? [])
  const visible = ordered.slice(0, MEMBER_ROW_CAP)
  const canManage = canManageProjectMembers({
    isOrganizationOwner,
    members: ordered,
    userId: me?.user.id,
  })
  const links: SectionLink[] = canManage
    ? [{ label: 'Manage', to: `/projects/${projectId}/settings` }]
    : []

  return (
    <DashboardSectionCard
      className={className}
      count={isPending ? undefined : ordered.length}
      links={links}
      title="Members"
    >
      {isPending ? <Skeleton className="p-2" variant="list" /> : null}
      {isError ? <SectionNotice>Members could not be loaded. Please refresh.</SectionNotice> : null}
      {!isPending && !isError && ordered.length === 0 ? (
        <SectionNotice>No members yet. Owners can add people in Settings.</SectionNotice>
      ) : null}
      {visible.map((member) => (
        <button
          className={dashboardRowClass}
          key={member.userId}
          onClick={() => navigateToDm(member.userId)}
          type="button"
        >
          <UserAvatar
            displayName={member.displayName}
            showPresence
            showStatus
            size={28}
            token={token}
            userId={member.userId}
          />
          <span className="truncate text-sm text-[color:var(--tx)]">{member.displayName}</span>
          <span className="ml-auto text-xs lowercase text-[color:var(--tx3)]">{member.role}</span>
        </button>
      ))}
      <SectionOverflowHint count={ordered.length - visible.length} noun="member" />
    </DashboardSectionCard>
  )
}

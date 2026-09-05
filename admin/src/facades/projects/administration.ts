import { PROJECT_ADMIN_ROLES } from '@nessie/schemas'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { useIsOwner } from '../auth/hooks'
import { useProjectMembers } from './hooks'

/**
 * May this person change the project's shape — its boards, columns, custom
 * fields and sources?
 *
 * Mirrors the server's `canAdministerProject` exactly: an organisation owner,
 * or somebody the project itself records as `owner` or `admin`. Like
 * `useIsOwner`, this is a *render* gate, not an authorization boundary — the
 * route re-checks and answers 403 either way. It exists so an administrative
 * control is not offered to somebody whose click would be refused.
 */
export const useCanAdministerProject = (projectId: string | null): boolean => {
  const isOwner = useIsOwner()
  const { me } = useAuthSession()
  // Owners administer every project, so the membership read is skipped for
  // them rather than fetched and ignored.
  const { data: members = [] } = useProjectMembers(isOwner ? null : projectId)
  if (isOwner) return true
  const userId = me?.user.id
  if (!userId) return false
  return members.some(
    (member) =>
      member.userId === userId &&
      (PROJECT_ADMIN_ROLES as readonly string[]).includes(member.role),
  )
}

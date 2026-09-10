import { PROJECT_ADMIN_ROLES } from '@nessie/schemas'
import { ApiClientError } from '@nessie/client-core'
import type { QueryClient } from '@tanstack/react-query'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { useIsOwner } from '../auth/hooks'
import { projectKeys } from './keys'
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
  const membersQuery = useProjectMembers(isOwner ? null : projectId)
  if (isOwner) return true
  const userId = me?.user.id
  // A cached membership must not outlive a failed or in-flight entitlement
  // check. Project shape controls therefore fail closed until this exact
  // project's current member list has resolved.
  if (!userId || !membersQuery.isSuccess || membersQuery.isFetching) return false
  return membersQuery.data.some(
    (member) =>
      member.userId === userId &&
      (PROJECT_ADMIN_ROLES as readonly string[]).includes(member.role),
  )
}

/**
 * The API is the authority for project administration. A 403 means an open
 * surface learned its cached decision has been revoked, so make every mounted
 * project-shape gate re-read that decision before offering another mutation.
 */
export const refreshProjectAdministrationAfterForbidden = (
  queryClient: QueryClient,
  projectId: string,
  error: unknown,
): void => {
  if (error instanceof ApiClientError && error.status === 403) {
    void queryClient.invalidateQueries({ queryKey: projectKeys.members(projectId) })
  }
}

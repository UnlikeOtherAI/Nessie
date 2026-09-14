import { ApiClientError } from '@nessie/client-core'
import type { QueryClient } from '@tanstack/react-query'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { useIsOrganizationAdmin } from '../auth/hooks'
import { projectKeys } from './keys'
import { useProjectMembers } from './hooks'

/**
 * May this person change the project — rename it, manage its members, archive
 * or delete it, and change its shape (boards, columns, custom fields, sources,
 * sprints, watchers)?
 *
 * Mirrors the server's `canModifyProject` exactly: an organisation owner or
 * admin, or any member of the project, whatever their project role. Like
 * `useIsOwner`, this is a *render* gate, not an authorization boundary — the
 * route re-checks either way. It exists so a control is not offered to somebody
 * whose click would be refused.
 */
export const useCanModifyProject = (projectId: string | null): boolean => {
  const isOrganizationAdmin = useIsOrganizationAdmin()
  const { me } = useAuthSession()
  // Owners and admins change every project, so the membership read is skipped
  // for them rather than fetched and ignored.
  const membersQuery = useProjectMembers(isOrganizationAdmin ? null : projectId)
  if (isOrganizationAdmin) return true
  const userId = me?.user.id
  // A cached membership must not outlive a failed or in-flight entitlement
  // check. Project controls therefore fail closed until this exact project's
  // current member list has resolved.
  if (!userId || !membersQuery.isSuccess || membersQuery.isFetching) return false
  return membersQuery.data.some((member) => member.userId === userId)
}

/**
 * The API is the authority for changing a project. A refusal means an open
 * surface learned its cached decision has been revoked — a 404 because the
 * person is no longer a member and so can no longer see the project — so make
 * every mounted project gate re-read that decision before offering another
 * mutation.
 */
export const refreshProjectAdministrationAfterForbidden = (
  queryClient: QueryClient,
  projectId: string,
  error: unknown,
): void => {
  if (error instanceof ApiClientError && (error.status === 403 || error.status === 404)) {
    void queryClient.invalidateQueries({ queryKey: projectKeys.members(projectId) })
  }
}

import type { MeResponse } from '@nessie/schemas'
import type { SessionPayload } from '@nessie/client-core'

type TenantQueryResetInput = {
  readCurrentMe: () => MeResponse | null
  resetTenantQueries: () => Promise<void>
}

type CurrentSessionSnapshotInput<Snapshot> = {
  fetchSession: (token: string | null) => Promise<Snapshot>
  readCurrentToken: () => string | null
}

export const hasSessionBoundaryChanged = (
  current: MeResponse | null,
  next: MeResponse,
): boolean => Boolean(
  current
  && (
    current.user.id !== next.user.id
    || current.context.organizationId !== next.context.organizationId
    || current.context.projectId !== next.context.projectId
    || current.context.teamId !== next.context.teamId
  )
)

/**
 * Profile mutations are issued under one access-token context but complete
 * outside the session mutation queue. Accept their full `/me` response only
 * while that exact user and tenant context is still current; otherwise a late
 * response could restore the previous team over a newly switched token.
 */
export const isCurrentSessionResponse = (
  current: MeResponse | null,
  response: MeResponse,
): boolean => Boolean(current && !hasSessionBoundaryChanged(current, response))

/**
 * Startup restoration may overlap a proactive refresh. A snapshot fetched with
 * the old bearer must not overwrite the session that won that mutation race.
 */
export const fetchCurrentSessionSnapshot = async <Snapshot>(
  input: CurrentSessionSnapshotInput<Snapshot>,
): Promise<Snapshot | null> => {
  const requestedToken = input.readCurrentToken()
  const snapshot = await input.fetchSession(requestedToken)
  return input.readCurrentToken() === requestedToken ? snapshot : null
}

/**
 * Cancel and discard tenant-owned queries before a replacement session is
 * exposed to React. This also covers ordinary refreshes after another tab has
 * rotated the shared cookie into a different team.
 */
export const createSessionQueryBoundary = (
  input: TenantQueryResetInput,
): {
  beforeApply: (payload: SessionPayload) => Promise<void>
  clear: () => Promise<void>
} => ({
  beforeApply: async (payload) => {
    if (!hasSessionBoundaryChanged(input.readCurrentMe(), payload.me)) return
    await input.resetTenantQueries()
  },
  clear: input.resetTenantQueries,
})

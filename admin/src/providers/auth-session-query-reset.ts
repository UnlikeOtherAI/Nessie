import type { MeResponse } from '@nessie/schemas'
import type { SessionPayload } from '@nessie/client-core'

type TenantQueryResetInput = {
  readCurrentMe: () => MeResponse | null
  resetTenantQueries: () => Promise<void>
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
 * Cancel and discard tenant-owned queries before a replacement session is
 * exposed to React. This also covers ordinary refreshes after another tab has
 * rotated the shared cookie into a different workspace.
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

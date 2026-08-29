import type {
  AppConnectionStatus,
  AppConnectionSummaryRecord,
  McpServerLifecycleState,
  McpServerScopeType,
} from '@nessie/schemas'

/**
 * A "connected account" as the App Store talks about it: one
 * `McpServerInstance` the caller is entitled to see, described in the store's
 * vocabulary rather than the connector model's.
 *
 * Spec: `docs/plans/2026-08-29-mcp-app-store/ux-design-detail-and-connect.md`
 * §3.
 */

export type AppConnectionInstance = {
  id: string
  scopeType: McpServerScopeType
  scopeId: string
  lifecycleState: McpServerLifecycleState
  healthLastCheckedAt: Date | null
}

/**
 * Who an install reaches, in the product's own words ("Who can use it"). An
 * instance carries no name of its own yet, and the scope is the fact that
 * actually distinguishes two accounts of the same app today.
 */
const SCOPE_LABELS: Record<McpServerScopeType, string> = {
  system: 'Everyone on this instance',
  organization: 'Everyone in the organisation',
  project: 'This project',
  team: 'This team',
  channel: 'This channel',
  user: 'Just me',
}

/**
 * Lifecycle → the store's connection status.
 *
 * `expired` is absent by construction in this phase: whether an OAuth grant
 * has lapsed is knowable only from the encrypted token bundle, which a
 * catalogue read must not open. A lapsed grant surfaces as `error`, which is
 * what the instance row already records once a dispatch or probe fails.
 */
export const deriveConnectionStatus = (
  lifecycleState: McpServerLifecycleState,
): AppConnectionStatus => {
  switch (lifecycleState) {
    case 'pending_setup':
      return 'connecting'
    case 'active':
      return 'connected'
    case 'paused':
      return 'disabled'
    case 'error':
      return 'error'
  }
}

/**
 * Normalized, outcome-first copy. `McpServerInstance.lastError` is an upstream
 * transport message — it can carry the endpoint URL and provider internals,
 * neither of which may reach this surface — so a member is told what happened
 * and what to do next, and never the raw string.
 */
const connectionErrorMessage = (
  status: AppConnectionStatus,
  appName: string,
): string | null => {
  switch (status) {
    case 'error':
      return `Something went wrong while connecting to ${appName}. Try reconnecting.`
    case 'expired':
      return `The sign-in for ${appName} is no longer valid. Reconnect to keep using it.`
    case 'connecting':
    case 'connected':
    case 'disabled':
      return null
  }
}

export const presentAppConnection = (
  instance: AppConnectionInstance,
  appName: string,
): AppConnectionSummaryRecord => {
  const status = deriveConnectionStatus(instance.lifecycleState)
  return {
    id: instance.id,
    displayName: SCOPE_LABELS[instance.scopeType],
    scopeType: instance.scopeType,
    scopeId: instance.scopeId,
    status,
    // `healthLastCheckedAt` is stamped by failed checks too, so it only means
    // "last reached" while the connection is actually healthy.
    lastConnectedAt:
      status === 'connected' && instance.healthLastCheckedAt
        ? instance.healthLastCheckedAt.toISOString()
        : null,
    errorMessage: connectionErrorMessage(status, appName),
  }
}

/** Caller-visible instances grouped by the app they connect. */
export const groupConnectionsByApp = <T extends { catalogEntryId: string }>(
  instances: readonly T[],
): Map<string, T[]> => {
  const byApp = new Map<string, T[]>()
  for (const instance of instances) {
    const existing = byApp.get(instance.catalogEntryId)
    if (existing) existing.push(instance)
    else byApp.set(instance.catalogEntryId, [instance])
  }
  return byApp
}

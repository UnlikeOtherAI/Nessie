/**
 * Cross-provider sync error surface. Adapters (Slack, Google, Microsoft) raise
 * these shared shapes so the worker can react uniformly: a provider whose
 * incremental cursor has expired needs a bounded re-sync, and a credential the
 * provider has rejected needs the user to re-authorize. Neither carries token
 * material.
 */

/**
 * Thrown by an adapter when a provider's incremental cursor / history token is
 * no longer valid (e.g. Gmail's stored `historyId` fell outside the retained
 * window). The worker must clear the stored cursor and run a bounded re-sync
 * rather than retrying the dead cursor forever. Provider adapters extend this
 * with their own typed variants (e.g. `GmailHistoryExpiredError`).
 */
export class SyncCursorExpiredError extends Error {
  constructor(message = 'sync cursor expired; a bounded re-sync is required') {
    super(message)
    this.name = 'SyncCursorExpiredError'
  }
}

/**
 * Duck-typed predicate for "this credential can no longer be used; the user
 * must re-authorize". Slack's `SlackApiError` and Google's
 * `GmailReauthorizationRequiredError` both expose a `readonly
 * needsReauthorization = true`; the worker checks the flag structurally so the
 * provider-agnostic core never imports a provider package.
 */
export const needsReauthorization = (err: unknown): boolean =>
  typeof err === 'object'
  && err !== null
  && (err as { needsReauthorization?: unknown }).needsReauthorization === true

import type { DeepWaterPendingActionErrorCode, LedgerToolError } from '@nessie/schemas'

/**
 * How a definitive Ledger refusal of a person's brief action reads in Nessie
 * (Water plan nessie.md §7.1 `pendingAction.error.code`). Ledger's own codes
 * come first (ledger.md §5.5, amendments L3, F3, W5); anything else falls back
 * on its HTTP status, and whatever is left is a plain rejection.
 */

const BY_LEDGER_CODE: Readonly<Record<string, DeepWaterPendingActionErrorCode>> = {
  scope_busy: 'busy',
  scope_revision_conflict: 'revision_conflict',
  scope_not_ready: 'not_ready',
  scope_limit: 'brief_limit',
  scope_message_limit: 'message_limit',
  budget_exceeded: 'budget_exceeded',
  forbidden: 'forbidden',
  pairing_required: 'forbidden',
  scope_author_unresolved: 'forbidden',
  public_requires_person: 'forbidden',
  owner_role_required: 'forbidden',
  not_drafting: 'not_drafting',
  not_scoped: 'not_drafting',
}

export const pendingActionErrorForLedger = (error: LedgerToolError): DeepWaterPendingActionErrorCode => {
  const known = BY_LEDGER_CODE[error.code]
  if (known) return known
  if (error.statusCode === 401) return 'identity_required'
  if (error.statusCode === 402) return 'budget_exceeded'
  if (error.statusCode === 403) return 'forbidden'
  return 'rejected'
}

/**
 * Did Ledger put the brief back to drafting when it refused this launch? It
 * does for Water's inline `scope-*` refusals (amendments L3), which reach
 * Nessie as Ledger's `scope_*` codes. Moving the run back is safe even when a
 * particular refusal came before Ledger moved it at all: the watch's next read
 * moves it forward again if Ledger shows otherwise.
 */
export const revertsLaunch = (ledgerCode: string): boolean => ledgerCode.startsWith('scope_')

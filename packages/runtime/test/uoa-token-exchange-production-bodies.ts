/**
 * The bodies UOA's production `/auth/token` answers a refused token exchange
 * with, pinned byte for byte from UnlikeOtherAuthenticator origin/main 2e7fb24:
 * `buildPublicErrorBody` (`API/src/utils/error-response.ts`) with
 * `DEBUG_ENABLED` off answers `{ error: PUBLIC_ERROR_MESSAGE, code }` only for a
 * code on `PRODUCTION_PUBLIC_ERROR_CODES` (`API/src/utils/public-error-codes.ts`)
 * and `{ error: PUBLIC_ERROR_MESSAGE }` for every other code. The refusals come
 * from `API/src/services/confidential-token-exchange.service.ts`.
 *
 * `TOKEN_EXCHANGE_SUBJECT_FORBIDDEN` is not on that list yet, so a person whose
 * sign-in epoch moved, or who lost the organisation, team or domain role, is
 * refused with the same bare 403 as a fault in Nessie's own delegation setup,
 * and Nessie cannot tell them apart (docs/standards/deepwater.md, "Identity
 * drift and UOA's rollout gate"). The gated body is what the UOA change that
 * lists the code, and gives the org-features/team-policy configuration refusal
 * its own code, must answer. When that change ships, replace
 * `movedEpochToday` with it and flip the test that reads it.
 */

export type UoaProductionRefusal = { status: number; body: Record<string, string> }

/** A moved sign-in epoch (`lockAndAssertAuthenticationEpoch` failing) as production answers it today. */
export const movedEpochToday: UoaProductionRefusal = {
  status: 403,
  body: { error: 'Request failed' },
}

/** A missing or disabled delegation mapping (`TOKEN_EXCHANGE_DELEGATION_NOT_ALLOWED`): a Nessie fault. */
export const delegationNotAllowedToday: UoaProductionRefusal = {
  status: 403,
  body: { error: 'Request failed' },
}

/** A moved sign-in epoch once UOA lists `TOKEN_EXCHANGE_SUBJECT_FORBIDDEN` as public: the rollout gate. */
export const movedEpochOnceGated: UoaProductionRefusal = {
  status: 403,
  body: { error: 'Request failed', code: 'TOKEN_EXCHANGE_SUBJECT_FORBIDDEN' },
}

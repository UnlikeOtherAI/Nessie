/**
 * The bodies UOA's production `/auth/token` answers a refused token exchange
 * with, pinned byte for byte from UnlikeOtherAuthenticator origin/main 66e10df
 * (PR #52, deployed): `buildPublicErrorBody` (`API/src/utils/error-response.ts`)
 * with `DEBUG_ENABLED` off answers `{ error: PUBLIC_ERROR_MESSAGE, code }` only
 * for a code on `PRODUCTION_PUBLIC_ERROR_CODES`
 * (`API/src/utils/public-error-codes.ts`) and `{ error: PUBLIC_ERROR_MESSAGE }`
 * for every other code. The refusals come from
 * `API/src/services/confidential-token-exchange.service.ts` and
 * `confidential-delegation.service.ts`.
 *
 * `TOKEN_EXCHANGE_SUBJECT_FORBIDDEN` is on that list: every refusal that
 * depends on the person's own current state — a moved sign-in epoch, an
 * unknown user, a lost source-domain role, a selected organisation or team no
 * longer available to them — answers it, so Nessie blocks the run on the
 * person and tells them (docs/standards/deepwater.md, "Identity drift"). The
 * product's own configuration refusals — a team context the product requires
 * or does not support (`TOKEN_EXCHANGE_TEAM_CONTEXT_REQUIRED`,
 * `TOKEN_EXCHANGE_TEAM_CONTEXT_UNSUPPORTED`) and a delegation its mapping does
 * not allow (`TOKEN_EXCHANGE_DELEGATION_NOT_ALLOWED`) — stay off the list, are
 * decided before any subject lookup, and answer the bare 403: Nessie's fault,
 * never the person's.
 */

export type UoaProductionRefusal = { status: number; body: Record<string, string> }

/** A moved sign-in epoch (`lockAndAssertAuthenticationEpoch` failing), as production answers it. */
export const movedEpochToday: UoaProductionRefusal = {
  status: 403,
  body: { error: 'Request failed', code: 'TOKEN_EXCHANGE_SUBJECT_FORBIDDEN' },
}

/** A missing or disabled delegation mapping (`TOKEN_EXCHANGE_DELEGATION_NOT_ALLOWED`): a Nessie fault. */
export const delegationNotAllowedToday: UoaProductionRefusal = {
  status: 403,
  body: { error: 'Request failed' },
}

/**
 * An active team asserted to a product whose organisation features are off
 * under a team policy other than `all_active_memberships`
 * (`TOKEN_EXCHANGE_TEAM_CONTEXT_UNSUPPORTED`): Nessie's configuration, a fault.
 */
export const teamContextUnsupportedToday: UoaProductionRefusal = {
  status: 403,
  body: { error: 'Request failed' },
}

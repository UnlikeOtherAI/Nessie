export const UOA_BILLING_CHECKOUT_RETURN_PARAMETER = 'uoa_billing'

export type UoaBillingCheckoutReturn =
  | 'checkout_complete'
  | 'checkout_cancelled'

export type UoaBillingCheckoutReturnNotice = {
  message: string
  title: string
}

const checkoutReturnValues: ReadonlySet<string> = new Set([
  'checkout_complete',
  'checkout_cancelled',
])

const normaliseSearch = (search: string): string => {
  if (!search) return ''
  return search.startsWith('?') ? search : `?${search}`
}

export const readUoaBillingCheckoutReturn = (
  search: string,
): UoaBillingCheckoutReturn | null => {
  const values = new URLSearchParams(search).getAll(
    UOA_BILLING_CHECKOUT_RETURN_PARAMETER,
  )
  if (values.length !== 1) return null

  const [value] = values
  return value && checkoutReturnValues.has(value)
    ? value as UoaBillingCheckoutReturn
    : null
}

// A notification destination is an explicit user action and must win over the
// ordinary root landing redirect (including a billing-return hint).
export const resolveRootLandingPath = (
  search: string,
  pendingPushPath: string | null = null,
): string =>
  pendingPushPath
    ?? (readUoaBillingCheckoutReturn(search)
      ? `/tokens${normaliseSearch(search)}`
      : '/channels')

export const getUoaBillingCheckoutReturnNotice = (
  checkoutReturn: UoaBillingCheckoutReturn,
): UoaBillingCheckoutReturnNotice => ({
  title: 'Billing checkout',
  message:
    checkoutReturn === 'checkout_cancelled'
      ? 'You are back from checkout. We are refreshing your team credits and billing details; no billing change is assumed.'
      : 'You are back from checkout. We are refreshing your team credits and billing details so they can show confirmed changes.',
})

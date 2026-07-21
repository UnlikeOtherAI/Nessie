import type { BillingHostedRedirectResponse } from '@unlikeotherai/billing-statement-protocol'

import { invalidUoaBillingResponse } from './uoa-billing-client.js'
import { parseBillingHostedRedirectResponse } from './uoa-billing-protocol.js'

const STRIPE_HOSTS = [
  'billing.stripe.com',
  'checkout.stripe.com',
] as const

type StripeHost = (typeof STRIPE_HOSTS)[number]

export const assertStripeRedirectUrl = (
  value: string,
  allowedHosts: readonly StripeHost[] = STRIPE_HOSTS,
): string => {
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:'
      || !allowedHosts.includes(url.hostname as StripeHost)
      || url.username
      || url.password
    ) {
      throw new Error('invalid')
    }
    return url.toString()
  } catch {
    return invalidUoaBillingResponse('an invalid Stripe redirect')
  }
}

export const parseUoaBillingHostedRedirect = (
  value: unknown,
): BillingHostedRedirectResponse => {
  const parsed = parseBillingHostedRedirectResponse(value)
  if (!parsed) {
    return invalidUoaBillingResponse('an invalid hosted redirect response')
  }
  return {
    redirect_url: assertStripeRedirectUrl(parsed.redirect_url),
  }
}

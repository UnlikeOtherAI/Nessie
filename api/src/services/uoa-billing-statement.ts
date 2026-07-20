import type { PrismaClient } from '@prisma/client'
import {
  UoaBillingCancellationConfirmationV1Schema,
  UoaBillingCancellationPreviewV1Schema,
  UoaBillingCheckoutResponseSchema,
  UoaBillingPortalResponseSchema,
  UoaBillingStatementV1Schema,
  type AuthorizedActionContext,
  type UoaBillingCancellationConfirmRequest,
  type UoaBillingCancellationConfirmationV1,
  type UoaBillingCancellationPreviewV1,
  type UoaBillingRedirectResponse,
  type UoaBillingStatementAction,
  type UoaBillingStatementV1,
} from '@nessie/schemas'
import {
  createUoaBillingClient,
  UoaBillingError,
  type UoaBillingClient,
  type UoaBillingClientDeps,
  type UoaBillingSubject,
} from './uoa-billing-client.js'

const NESSIE_PRODUCT = 'nessie'
const STATEMENT_PATH = '/billing/v1/customer-statement'
const CONFIRM_CANCELLATION_PATH = '/billing/v1/cancellation/confirm'
const ACTION_CONTRACT = {
  upgrade: {
    kind: 'hosted_redirect',
    path: '/billing/v1/stripe/checkout-session',
  },
  portal: {
    kind: 'hosted_redirect',
    path: '/billing/v1/stripe/portal-session',
  },
  cancel: {
    kind: 'confirmation_dialog',
    path: '/billing/v1/cancellation/preview',
  },
} as const

type BillingStatementPrisma = Pick<
  PrismaClient,
  'productAccountLink' | 'team'
>
type HostedActionId = 'portal' | 'upgrade'

const subjectBody = (
  subject: UoaBillingSubject,
): Record<string, string> => ({
  product: NESSIE_PRODUCT,
  organisation_id: subject.organizationId,
  team_id: subject.teamId,
  user_id: subject.userId,
})

const invalidResponse = (description: string): never => {
  throw new UoaBillingError(
    'UOA_BILLING_RESPONSE_INVALID',
    `UnlikeOtherAI billing returned ${description}.`,
    502,
  )
}

const parseStatement = (
  value: unknown,
  subject: UoaBillingSubject,
): UoaBillingStatementV1 => {
  const parsed = UoaBillingStatementV1Schema.safeParse(value)
  if (
    !parsed.success
    || parsed.data.product.identifier !== NESSIE_PRODUCT
    || parsed.data.subject.user_id !== subject.userId
    || parsed.data.subject.organisation_id !== subject.organizationId
    || parsed.data.subject.team_id !== subject.teamId
    || new Set(parsed.data.pinned_inputs.ledger_snapshots.map(
      (snapshot) => snapshot.group_by,
    )).size !== 2
  ) {
    return invalidResponse('an invalid canonical statement')
  }
  return parsed.data
}

const loadStatement = async (
  client: UoaBillingClient,
  billingMonth?: string,
): Promise<UoaBillingStatementV1> => {
  const body: Record<string, string> = subjectBody(client.subject)
  if (billingMonth) body.billing_month = billingMonth
  return parseStatement(
    await client.post(STATEMENT_PATH, body),
    client.subject,
  )
}

const actionFor = (
  statement: UoaBillingStatementV1,
  id: keyof typeof ACTION_CONTRACT,
  subject: UoaBillingSubject,
): UoaBillingStatementAction => {
  const matches = statement.actions.filter((action) => action.id === id)
  const action = matches[0]
  const expected = ACTION_CONTRACT[id]
  const expectedBody = subjectBody(subject)
  if (
    matches.length !== 1
    || !action
    || action.kind !== expected.kind
    || action.request.method !== 'POST'
    || action.request.path !== expected.path
    || Object.entries(expectedBody).some(
      ([key, value]) => action.request.body[key] !== value,
    )
  ) {
    throw new UoaBillingError(
      'UOA_BILLING_ACTION_INVALID',
      'UnlikeOtherAI returned an invalid billing action.',
      502,
    )
  }
  if (!action.enabled) {
    throw new UoaBillingError(
      'UOA_BILLING_ACTION_UNAVAILABLE',
      action.disabled_reason ?? 'This billing action is unavailable.',
      409,
    )
  }
  return action
}

const assertStripeRedirect = (
  value: string,
  action: HostedActionId,
): string => {
  try {
    const url = new URL(value)
    const expectedHost =
      action === 'upgrade' ? 'checkout.stripe.com' : 'billing.stripe.com'
    if (
      url.protocol !== 'https:'
      || url.hostname !== expectedHost
      || url.username
      || url.password
    ) {
      throw new Error('invalid')
    }
    return url.toString()
  } catch {
    return invalidResponse('an invalid Stripe redirect')
  }
}

export const getUoaBillingStatement = async (
  prisma: BillingStatementPrisma,
  actorContext: AuthorizedActionContext,
  billingMonth?: string,
  deps?: UoaBillingClientDeps,
): Promise<UoaBillingStatementV1> =>
  loadStatement(
    await createUoaBillingClient(prisma, actorContext, deps),
    billingMonth,
  )

export const executeUoaBillingHostedAction = async (
  prisma: BillingStatementPrisma,
  actorContext: AuthorizedActionContext,
  id: HostedActionId,
  deps?: UoaBillingClientDeps,
): Promise<UoaBillingRedirectResponse> => {
  const client = await createUoaBillingClient(prisma, actorContext, deps)
  const action = actionFor(
    await loadStatement(client),
    id,
    client.subject,
  )
  const response = await client.post(action.request.path, action.request.body)
  if (id === 'upgrade') {
    const parsed = UoaBillingCheckoutResponseSchema.safeParse(response)
    if (!parsed.success) return invalidResponse('an invalid Checkout response')
    return {
      redirect_url: assertStripeRedirect(parsed.data.checkout_url, id),
    }
  }
  const parsed = UoaBillingPortalResponseSchema.safeParse(response)
  if (!parsed.success) return invalidResponse('an invalid portal response')
  return {
    redirect_url: assertStripeRedirect(parsed.data.portal_url, id),
  }
}

export const createUoaBillingCancellationPreview = async (
  prisma: BillingStatementPrisma,
  actorContext: AuthorizedActionContext,
  deps?: UoaBillingClientDeps,
): Promise<UoaBillingCancellationPreviewV1> => {
  const client = await createUoaBillingClient(prisma, actorContext, deps)
  const action = actionFor(
    await loadStatement(client),
    'cancel',
    client.subject,
  )
  const parsed = UoaBillingCancellationPreviewV1Schema.safeParse(
    await client.post(action.request.path, action.request.body),
  )
  if (!parsed.success) return invalidResponse('an invalid cancellation preview')
  if (
    parsed.data.choice_required
      !== parsed.data.confirm_action.selection_required
    || (parsed.data.choice_required
      && parsed.data.confirm_action.default_selection !== null)
    || (!parsed.data.choice_required
      && parsed.data.confirm_action.default_selection !== 'current_service')
  ) {
    return invalidResponse('an inconsistent cancellation preview')
  }
  return parsed.data
}

export const confirmUoaBillingCancellation = async (
  prisma: BillingStatementPrisma,
  actorContext: AuthorizedActionContext,
  request: UoaBillingCancellationConfirmRequest,
  deps?: UoaBillingClientDeps,
): Promise<UoaBillingCancellationConfirmationV1> => {
  const client = await createUoaBillingClient(prisma, actorContext, deps)
  const parsed = UoaBillingCancellationConfirmationV1Schema.safeParse(
    await client.post(CONFIRM_CANCELLATION_PATH, {
      ...subjectBody(client.subject),
      preview_token: request.preview_token,
      idempotency_key: request.idempotency_key,
      selection: request.selection,
    }),
  )
  if (!parsed.success) {
    return invalidResponse('an invalid cancellation confirmation')
  }
  return parsed.data
}


import type { PrismaClient } from '@prisma/client'
import {
  UoaBillingCheckoutResponseSchema,
  UoaBillingPortalResponseSchema,
  type AuthorizedActionContext,
} from '@nessie/schemas'
import type {
  BillingCancellationConfirmationV1,
  BillingCancellationConfirmRequest,
  BillingCancellationPreviewV1,
  BillingHostedRedirectResponse,
  BillingStatementAction,
  BillingStatementV2,
} from '@unlikeotherai/billing-statement-protocol'
import {
  createUoaBillingClient,
  UoaBillingError,
  type UoaBillingClient,
  type UoaBillingClientDeps,
  type UoaBillingSubject,
} from './uoa-billing-client.js'
import {
  parseBillingCancellationConfirmationV1,
  parseBillingCancellationPreviewV1,
  parseBillingHostedRedirectResponse,
  parseBillingStatementV2,
} from './uoa-billing-protocol.js'

const NESSIE_PRODUCT = 'nessie'
const STATEMENT_PATH = '/billing/v2/customer-statement'
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
): BillingStatementV2 => {
  const statement = parseBillingStatementV2(value)
  const snapshot = statement?.pinned_inputs.ledger_snapshots[0]
  if (
    !statement
    || statement.product.identifier !== NESSIE_PRODUCT
    || statement.subject.user_id !== subject.userId
    || statement.subject.organisation_id !== subject.organizationId
    || statement.subject.team_id !== subject.teamId
    || statement.connected_service_usage.statement_product !== NESSIE_PRODUCT
    || !snapshot
    || snapshot.contract !== 'metering-portfolio-v1'
    || snapshot.group_by !== 'user'
    || snapshot.cursor !== snapshot.id
  ) {
    return invalidResponse('an invalid canonical statement')
  }
  return statement
}

const loadStatement = async (
  client: UoaBillingClient,
  billingMonth?: string,
): Promise<BillingStatementV2> => {
  const body: Record<string, string> = subjectBody(client.subject)
  if (billingMonth) body.billing_month = billingMonth
  return parseStatement(
    await client.post(STATEMENT_PATH, body),
    client.subject,
  )
}

const actionFor = (
  statement: BillingStatementV2,
  id: keyof typeof ACTION_CONTRACT,
  subject: UoaBillingSubject,
): BillingStatementAction => {
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
): Promise<BillingStatementV2> =>
  loadStatement(
    await createUoaBillingClient(prisma, actorContext, deps),
    billingMonth,
  )

export const executeUoaBillingHostedAction = async (
  prisma: BillingStatementPrisma,
  actorContext: AuthorizedActionContext,
  id: HostedActionId,
  deps?: UoaBillingClientDeps,
): Promise<BillingHostedRedirectResponse> => {
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
    const result = {
      redirect_url: assertStripeRedirect(parsed.data.checkout_url, id),
    }
    return parseBillingHostedRedirectResponse(result)
      ?? invalidResponse('an invalid hosted redirect response')
  }
  const parsed = UoaBillingPortalResponseSchema.safeParse(response)
  if (!parsed.success) return invalidResponse('an invalid portal response')
  const result = {
    redirect_url: assertStripeRedirect(parsed.data.portal_url, id),
  }
  return parseBillingHostedRedirectResponse(result)
    ?? invalidResponse('an invalid hosted redirect response')
}

export const createUoaBillingCancellationPreview = async (
  prisma: BillingStatementPrisma,
  actorContext: AuthorizedActionContext,
  deps?: UoaBillingClientDeps,
): Promise<BillingCancellationPreviewV1> => {
  const client = await createUoaBillingClient(prisma, actorContext, deps)
  const action = actionFor(
    await loadStatement(client),
    'cancel',
    client.subject,
  )
  const preview = parseBillingCancellationPreviewV1(
    await client.post(action.request.path, action.request.body),
  )
  if (!preview) return invalidResponse('an invalid cancellation preview')
  if (
    preview.choice_required
      !== preview.confirm_action.selection_required
    || (preview.choice_required
      && preview.confirm_action.default_selection !== null)
    || (!preview.choice_required
      && preview.confirm_action.default_selection !== 'current_service')
  ) {
    return invalidResponse('an inconsistent cancellation preview')
  }
  return preview
}

export const confirmUoaBillingCancellation = async (
  prisma: BillingStatementPrisma,
  actorContext: AuthorizedActionContext,
  request: BillingCancellationConfirmRequest,
  deps?: UoaBillingClientDeps,
): Promise<BillingCancellationConfirmationV1> => {
  const client = await createUoaBillingClient(prisma, actorContext, deps)
  const confirmation = parseBillingCancellationConfirmationV1(
    await client.post(CONFIRM_CANCELLATION_PATH, {
      ...subjectBody(client.subject),
      preview_token: request.preview_token,
      idempotency_key: request.idempotency_key,
      selection: request.selection,
    }),
  )
  if (!confirmation) {
    return invalidResponse('an invalid cancellation confirmation')
  }
  return confirmation
}

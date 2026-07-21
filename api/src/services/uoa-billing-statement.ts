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
import { requireUoaFrozenAction } from './uoa-billing-action.js'
import {
  createUoaBillingSubjectBody,
  createUoaBillingClient,
  invalidUoaBillingResponse,
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
import { assertStripeRedirectUrl } from './uoa-billing-redirect.js'

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

const parseStatement = (
  value: unknown,
  subject: UoaBillingSubject,
  billingMonth?: string,
): BillingStatementV2 => {
  const statement = parseBillingStatementV2(value)
  const snapshot = statement?.pinned_inputs.ledger_snapshots[0]
  if (
    !statement
    || statement.product.identifier !== NESSIE_PRODUCT
    || statement.subject.user_id !== subject.userId
    || statement.subject.organisation_id !== subject.organizationId
    || statement.subject.team_id !== subject.teamId
    || (billingMonth !== undefined && statement.period.key !== billingMonth)
    || statement.plan.tariff_id !== statement.pinned_inputs.tariff.id
    || statement.plan.version !== statement.pinned_inputs.tariff.version
    || statement.connected_service_usage.statement_product !== NESSIE_PRODUCT
    || !snapshot
    || snapshot.contract !== 'metering-portfolio-v1'
    || snapshot.group_by !== 'user'
    || snapshot.cursor !== snapshot.id
  ) {
    return invalidUoaBillingResponse('an invalid canonical statement')
  }
  return statement
}

const loadStatement = async (
  client: UoaBillingClient,
  billingMonth?: string,
): Promise<BillingStatementV2> => {
  const body: Record<string, string> = createUoaBillingSubjectBody(client.subject)
  if (billingMonth) body.billing_month = billingMonth
  return parseStatement(
    await client.post(STATEMENT_PATH, body),
    client.subject,
    billingMonth,
  )
}

const actionFor = (
  statement: BillingStatementV2,
  id: keyof typeof ACTION_CONTRACT,
  subject: UoaBillingSubject,
): BillingStatementAction => {
  const matches = statement.actions.filter((action) => action.id === id)
  const expected = ACTION_CONTRACT[id]
  return requireUoaFrozenAction(matches, {
    body: createUoaBillingSubjectBody(subject),
    bodyMatch: 'contains',
    id,
    kind: expected.kind,
    path: expected.path,
  })
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
    if (!parsed.success) {
      return invalidUoaBillingResponse('an invalid Checkout response')
    }
    const result = {
      redirect_url: assertStripeRedirectUrl(
        parsed.data.checkout_url,
        ['checkout.stripe.com'],
      ),
    }
    return parseBillingHostedRedirectResponse(result)
      ?? invalidUoaBillingResponse('an invalid hosted redirect response')
  }
  const parsed = UoaBillingPortalResponseSchema.safeParse(response)
  if (!parsed.success) {
    return invalidUoaBillingResponse('an invalid portal response')
  }
  const result = {
    redirect_url: assertStripeRedirectUrl(
      parsed.data.portal_url,
      ['billing.stripe.com'],
    ),
  }
  return parseBillingHostedRedirectResponse(result)
    ?? invalidUoaBillingResponse('an invalid hosted redirect response')
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
  if (!preview) {
    return invalidUoaBillingResponse('an invalid cancellation preview')
  }
  if (
    preview.choice_required
      !== preview.confirm_action.selection_required
    || (preview.choice_required
      && preview.confirm_action.default_selection !== null)
    || (!preview.choice_required
      && preview.confirm_action.default_selection !== 'current_service')
  ) {
    return invalidUoaBillingResponse('an inconsistent cancellation preview')
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
      ...createUoaBillingSubjectBody(client.subject),
      preview_token: request.preview_token,
      idempotency_key: request.idempotency_key,
      selection: request.selection,
    }),
  )
  if (!confirmation) {
    return invalidUoaBillingResponse('an invalid cancellation confirmation')
  }
  return confirmation
}

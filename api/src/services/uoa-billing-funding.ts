import type { PrismaClient } from '@prisma/client'
import {
  BILLING_CREDITS_AUTO_TOP_UP_DISABLE_PATH,
  BILLING_CREDITS_AUTO_TOP_UP_RECOVER_PATH,
  BILLING_CREDITS_AUTO_TOP_UP_SETUP_PATH,
  BILLING_CREDITS_AUTO_TOP_UP_UPDATE_PATH,
  BILLING_CREDITS_READ_PATH,
  BILLING_CREDITS_TOP_UP_PATH,
  BILLING_RECURRING_ADDONS_CANCELLATION_CONFIRM_PATH,
  BILLING_RECURRING_ADDONS_CANCELLATION_PREVIEW_PATH,
  BILLING_RECURRING_ADDONS_CHECKOUT_PATH,
  BILLING_RECURRING_ADDONS_READ_PATH,
  type BillingCreditsV1,
  type BillingCreditsManagerV1,
  type BillingHostedRedirectResponse,
  type BillingRecurringAddonCancellationConfirmationV1,
  type BillingRecurringAddonCancellationPreviewV1,
  type BillingRecurringAddonsManagerV1,
  type BillingRecurringAddonsV1,
} from '@unlikeotherai/billing-statement-protocol'
import type { AuthorizedActionContext } from '@nessie/schemas'

import {
  hasExactUoaActionBody,
  requireUoaFrozenAction,
} from './uoa-billing-action.js'
import {
  createUoaBillingClient,
  createUoaBillingSubjectBody,
  invalidUoaBillingResponse,
  UoaBillingError,
  type UoaBillingClient,
  type UoaBillingClientDeps,
  type UoaBillingSubject,
} from './uoa-billing-client.js'
import {
  parseBillingCreditsV1,
  parseBillingRecurringAddonCancellationConfirmationV1,
  parseBillingRecurringAddonCancellationPreviewV1,
  parseBillingRecurringAddonsV1,
} from './uoa-billing-protocol.js'
import { parseUoaBillingHostedRedirect } from './uoa-billing-redirect.js'

const NESSIE_PRODUCT = 'nessie'

export type BillingFundingPrisma = Pick<
  PrismaClient,
  'productAccountLink' | 'team'
>

const hasExactSubject = (
  value: {
    subject: {
      user_id: string
      organisation_id: string
      team_id: string
    }
  },
  subject: UoaBillingSubject,
): boolean =>
  value.subject.user_id === subject.userId
  && value.subject.organisation_id === subject.organizationId
  && value.subject.team_id === subject.teamId

const loadCredits = async (
  client: UoaBillingClient,
): Promise<BillingCreditsV1> => {
  const credits = parseBillingCreditsV1(
    await client.post(
      BILLING_CREDITS_READ_PATH,
      createUoaBillingSubjectBody(client.subject),
    ),
  )
  if (
    !credits
    || credits.storefront.identifier !== NESSIE_PRODUCT
    || !hasExactSubject(credits, client.subject)
  ) {
    return invalidUoaBillingResponse('an invalid credits projection')
  }
  return credits
}

const loadRecurringAddons = async (
  client: UoaBillingClient,
): Promise<BillingRecurringAddonsV1> => {
  const addons = parseBillingRecurringAddonsV1(
    await client.post(
      BILLING_RECURRING_ADDONS_READ_PATH,
      createUoaBillingSubjectBody(client.subject),
    ),
  )
  if (
    !addons
    || addons.product.identifier !== NESSIE_PRODUCT
    || !hasExactSubject(addons, client.subject)
  ) {
    return invalidUoaBillingResponse('an invalid recurring add-on projection')
  }
  return addons
}

export const getUoaBillingCredits = async (
  prisma: BillingFundingPrisma,
  actorContext: AuthorizedActionContext,
  deps?: UoaBillingClientDeps,
): Promise<BillingCreditsV1> =>
  loadCredits(await createUoaBillingClient(prisma, actorContext, deps))

export const getUoaBillingRecurringAddons = async (
  prisma: BillingFundingPrisma,
  actorContext: AuthorizedActionContext,
  deps?: UoaBillingClientDeps,
): Promise<BillingRecurringAddonsV1> =>
  loadRecurringAddons(await createUoaBillingClient(prisma, actorContext, deps))

const unavailable = (): never => {
  throw new UoaBillingError(
    'UOA_BILLING_ACTION_UNAVAILABLE',
    'This billing action is unavailable.',
    409,
  )
}

const isManagerCredits = (
  credits: BillingCreditsV1,
): credits is BillingCreditsManagerV1 =>
  credits.viewer.role === 'billing_manager'

const isManagerAddons = (
  addons: BillingRecurringAddonsV1,
): addons is BillingRecurringAddonsManagerV1 =>
  addons.viewer.role === 'billing_manager'

const managerCredits = (
  credits: BillingCreditsV1,
): BillingCreditsManagerV1 => {
  if (!isManagerCredits(credits)) return unavailable()
  return credits
}

const managerAddons = (
  addons: BillingRecurringAddonsV1,
): BillingRecurringAddonsManagerV1 => {
  if (!isManagerAddons(addons)) return unavailable()
  return addons
}

const hostedAction = async (
  client: UoaBillingClient,
  action: {
    request: {
      body: Readonly<Record<string, unknown>>
      path: string
    }
  },
): Promise<BillingHostedRedirectResponse> =>
  parseUoaBillingHostedRedirect(
    await client.post(action.request.path, action.request.body),
  )

export const createUoaBillingCreditTopUp = async (
  prisma: BillingFundingPrisma,
  actorContext: AuthorizedActionContext,
  offerId: string,
  deps?: UoaBillingClientDeps,
): Promise<BillingHostedRedirectResponse> => {
  const client = await createUoaBillingClient(prisma, actorContext, deps)
  const credits = managerCredits(await loadCredits(client))
  const matches = credits.funding_policy.offers
    .filter((offer) => offer.id === offerId)
    .map((offer) => offer.action)
  const action = requireUoaFrozenAction(matches, {
    body: { ...createUoaBillingSubjectBody(client.subject), offer_id: offerId },
    id: 'top_up',
    kind: 'hosted_redirect',
    path: BILLING_CREDITS_TOP_UP_PATH,
  })
  return hostedAction(client, action)
}

const autoTopUpOptionAction = async (
  prisma: BillingFundingPrisma,
  actorContext: AuthorizedActionContext,
  optionId: string,
  actionKind: 'setup' | 'update',
  deps?: UoaBillingClientDeps,
) => {
  const client = await createUoaBillingClient(prisma, actorContext, deps)
  const credits = managerCredits(await loadCredits(client))
  const matches = credits.automatic_top_up.options
    .map((option) => actionKind === 'setup'
      ? option.setup_action
      : option.update_action)
    .filter((action) => action.request.body.option_id === optionId)
  const action = requireUoaFrozenAction(matches, {
    body: { ...createUoaBillingSubjectBody(client.subject), option_id: optionId },
    id: actionKind === 'setup' ? 'auto_top_up_setup' : 'auto_top_up_update',
    kind: actionKind === 'setup' ? 'hosted_redirect' : 'mutation',
    path: actionKind === 'setup'
      ? BILLING_CREDITS_AUTO_TOP_UP_SETUP_PATH
      : BILLING_CREDITS_AUTO_TOP_UP_UPDATE_PATH,
  })
  return { action, client }
}

export const createUoaBillingAutoTopUpSetup = async (
  prisma: BillingFundingPrisma,
  actorContext: AuthorizedActionContext,
  optionId: string,
  deps?: UoaBillingClientDeps,
): Promise<BillingHostedRedirectResponse> => {
  const { action, client } = await autoTopUpOptionAction(
    prisma,
    actorContext,
    optionId,
    'setup',
    deps,
  )
  return hostedAction(client, action)
}

export const updateUoaBillingAutoTopUp = async (
  prisma: BillingFundingPrisma,
  actorContext: AuthorizedActionContext,
  optionId: string,
  deps?: UoaBillingClientDeps,
): Promise<void> => {
  const { action, client } = await autoTopUpOptionAction(
    prisma,
    actorContext,
    optionId,
    'update',
    deps,
  )
  await client.postNoContent(action.request.path, action.request.body)
}

const topLevelAutoTopUpAction = async (
  prisma: BillingFundingPrisma,
  actorContext: AuthorizedActionContext,
  kind: 'disable' | 'recover',
  deps?: UoaBillingClientDeps,
) => {
  const client = await createUoaBillingClient(prisma, actorContext, deps)
  const credits = managerCredits(await loadCredits(client))
  const candidate = kind === 'disable'
    ? credits.automatic_top_up.disable_action
    : credits.automatic_top_up.recover_action
  const action = requireUoaFrozenAction(candidate ? [candidate] : [], {
    body: createUoaBillingSubjectBody(client.subject),
    id: kind === 'disable' ? 'auto_top_up_disable' : 'auto_top_up_recover',
    kind: kind === 'disable' ? 'mutation' : 'hosted_redirect',
    path: kind === 'disable'
      ? BILLING_CREDITS_AUTO_TOP_UP_DISABLE_PATH
      : BILLING_CREDITS_AUTO_TOP_UP_RECOVER_PATH,
  })
  return { action, client }
}

export const disableUoaBillingAutoTopUp = async (
  prisma: BillingFundingPrisma,
  actorContext: AuthorizedActionContext,
  deps?: UoaBillingClientDeps,
): Promise<void> => {
  const { action, client } = await topLevelAutoTopUpAction(
    prisma,
    actorContext,
    'disable',
    deps,
  )
  await client.postNoContent(action.request.path, action.request.body)
}

export const recoverUoaBillingAutoTopUp = async (
  prisma: BillingFundingPrisma,
  actorContext: AuthorizedActionContext,
  deps?: UoaBillingClientDeps,
): Promise<BillingHostedRedirectResponse> => {
  const { action, client } = await topLevelAutoTopUpAction(
    prisma,
    actorContext,
    'recover',
    deps,
  )
  return hostedAction(client, action)
}

export const createUoaBillingRecurringAddonCheckout = async (
  prisma: BillingFundingPrisma,
  actorContext: AuthorizedActionContext,
  offerId: string,
  deps?: UoaBillingClientDeps,
): Promise<BillingHostedRedirectResponse> => {
  const client = await createUoaBillingClient(prisma, actorContext, deps)
  const addons = managerAddons(await loadRecurringAddons(client))
  const matches = addons.offers
    .filter((offer) => offer.id === offerId)
    .flatMap((offer) => offer.actions)
    .filter((action) => action.id === 'subscribe')
  const action = requireUoaFrozenAction(matches, {
    body: { ...createUoaBillingSubjectBody(client.subject), offer_id: offerId },
    id: 'subscribe',
    kind: 'hosted_redirect',
    path: BILLING_RECURRING_ADDONS_CHECKOUT_PATH,
  })
  return hostedAction(client, action)
}

export const createUoaBillingRecurringAddonCancellationPreview = async (
  prisma: BillingFundingPrisma,
  actorContext: AuthorizedActionContext,
  subscriptionId: string,
  deps?: UoaBillingClientDeps,
): Promise<BillingRecurringAddonCancellationPreviewV1> => {
  const client = await createUoaBillingClient(prisma, actorContext, deps)
  const addons = managerAddons(await loadRecurringAddons(client))
  const matches = addons.offers
    .flatMap((offer) => offer.actions)
    .filter((action) =>
      action.id === 'cancel'
      && action.request.body.subscription_id === subscriptionId)
  const action = requireUoaFrozenAction(matches, {
    body: {
      ...createUoaBillingSubjectBody(client.subject),
      subscription_id: subscriptionId,
    },
    id: 'cancel',
    kind: 'confirmation_dialog',
    path: BILLING_RECURRING_ADDONS_CANCELLATION_PREVIEW_PATH,
  })
  const preview = parseBillingRecurringAddonCancellationPreviewV1(
    await client.post(action.request.path, action.request.body),
  )
  if (
    !preview
    || preview.subscription.id !== subscriptionId
    || preview.confirm_action.method !== 'POST'
    || preview.confirm_action.path
      !== BILLING_RECURRING_ADDONS_CANCELLATION_CONFIRM_PATH
    || !hasExactUoaActionBody(preview.confirm_action.body, {
      ...createUoaBillingSubjectBody(client.subject),
      preview_token: preview.preview_token,
      idempotency_key: preview.idempotency_key,
      choice: 'cancel_addon',
    })
  ) {
    return invalidUoaBillingResponse('an invalid add-on cancellation preview')
  }
  return preview
}

export type UoaRecurringAddonCancellationConfirmationRequest = {
  preview_token: string
  idempotency_key: string
  choice: 'cancel_addon'
}

export const confirmUoaBillingRecurringAddonCancellation = async (
  prisma: BillingFundingPrisma,
  actorContext: AuthorizedActionContext,
  request: UoaRecurringAddonCancellationConfirmationRequest,
  deps?: UoaBillingClientDeps,
): Promise<BillingRecurringAddonCancellationConfirmationV1> => {
  const client = await createUoaBillingClient(prisma, actorContext, deps)
  const confirmation =
    parseBillingRecurringAddonCancellationConfirmationV1(
      await client.post(BILLING_RECURRING_ADDONS_CANCELLATION_CONFIRM_PATH, {
        ...createUoaBillingSubjectBody(client.subject),
        ...request,
      }),
    )
  return confirmation
    ?? invalidUoaBillingResponse('an invalid add-on cancellation confirmation')
}

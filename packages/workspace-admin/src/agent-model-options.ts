import type { PrismaClient } from '@prisma/client'
import type { ModelConfig } from '@nessie/config'
import type { AgentModelOption } from '@nessie/schemas'
import {
  listUserSubscriptions,
  requireSubscriptionAdapter,
  subscriptionProviderKeyToColumn,
} from '@nessie/model-subscriptions'
import { listLedgerAgentModels } from './ledger-agent-model-catalog.js'

/**
 * The model options one person may pick from: the deployment's Ledger
 * catalogue plus their own linked subscriptions.
 *
 * The two sources are resolved INDEPENDENTLY and a failure in one never hides
 * the other. Ledger being unreachable or out of credit must not make a person's
 * own paid subscriptions disappear from the picker — that would take away the
 * one option still able to run.
 *
 * Spec: docs/plans/2026-09-02-personal-model-subscriptions.md §2.3.
 */
export type AgentModelOptionsResult = {
  options: AgentModelOption[]
  /** Set when the Ledger catalogue could not be read; subscriptions still list. */
  ledgerError: { code: string; message: string } | null
}

export const listSubscriptionModelOptions = async (
  prisma: PrismaClient,
  input: { organizationId: string; userId: string | null | undefined },
): Promise<AgentModelOption[]> => {
  if (!input.userId) return []
  const subscriptions = await listUserSubscriptions(
    { prisma, secretStore: null },
    { organizationId: input.organizationId, userId: input.userId },
  )
  const perProviderCount = new Map<string, number>()
  for (const row of subscriptions) {
    perProviderCount.set(row.provider, (perProviderCount.get(row.provider) ?? 0) + 1)
  }
  const options: AgentModelOption[] = []
  for (const subscription of subscriptions) {
    const adapter = requireSubscriptionAdapter(subscription.provider)
    // The account label only earns its place when a person actually has two
    // accounts at one provider; otherwise it is noise beside every row.
    const showAccount = (perProviderCount.get(subscription.provider) ?? 0) > 1
    for (const model of adapter.models) {
      options.push({
        ...(showAccount && subscription.accountLabel
          ? { accountLabel: subscription.accountLabel }
          : {}),
        ...(model.description ? { description: model.description } : {}),
        displayName: model.displayName,
        model: model.model,
        modelSubscriptionId: subscription.id,
        provider: subscriptionProviderKeyToColumn(adapter.key),
        providerDisplayName: adapter.displayName,
        source: 'subscription',
      })
    }
  }
  return options
}

export const listAgentModelOptionsForUser = async (
  prisma: PrismaClient,
  input: {
    config: Pick<ModelConfig, 'apiKey' | 'baseUrl'>
    ledgerPublicUrl?: string
    organizationId: string
    requestHeaders?: Record<string, string>
    userId: string | null | undefined
  },
): Promise<AgentModelOptionsResult> => {
  const [ledger, subscriptions] = await Promise.allSettled([
    listLedgerAgentModels({
      config: input.config,
      ...(input.ledgerPublicUrl ? { ledgerPublicUrl: input.ledgerPublicUrl } : {}),
      ...(input.requestHeaders ? { requestHeaders: input.requestHeaders } : {}),
    }),
    listSubscriptionModelOptions(prisma, {
      organizationId: input.organizationId,
      userId: input.userId,
    }),
  ])

  const ledgerOptions: AgentModelOption[] =
    ledger.status === 'fulfilled'
      ? ledger.value.map((option) => ({ ...option, source: 'ledger' as const }))
      : []
  const ledgerError =
    ledger.status === 'rejected'
      ? {
        code:
          typeof (ledger.reason as { code?: unknown })?.code === 'string'
            ? (ledger.reason as { code: string }).code
            : 'LEDGER_MODEL_CATALOG_REQUEST_FAILED',
        message:
          ledger.reason instanceof Error
            ? ledger.reason.message
            : 'The model catalogue could not be read.',
      }
      : null

  const subscriptionOptions =
    subscriptions.status === 'fulfilled' ? subscriptions.value : []

  return {
    ledgerError,
    options: [...ledgerOptions, ...subscriptionOptions],
  }
}

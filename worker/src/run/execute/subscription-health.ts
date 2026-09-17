import {
  parseSubscriptionProviderColumn,
  recordSubscriptionFailure,
  recordSubscriptionSuccess,
  requireSubscriptionAdapter,
} from '@nessie/model-subscriptions'
import { providerFailureDetails } from '@nessie/runtime'
import type { ExecutionDependencies, RunContext } from './types.js'

const statusFromError = (error: unknown): number | undefined => {
  const details = providerFailureDetails(error)
  if (details?.statusCode) return details.statusCode
  const message = error instanceof Error ? error.message : ''
  const match = message.match(/(?:status|http)[:\s]*(\d{3})/i)
  return match ? parseInt(match[1]!, 10) : undefined
}

export const noteSubscriptionFailure = async (
  deps: ExecutionDependencies,
  context: RunContext,
  input: { error: unknown; messageText: string },
): Promise<void> => {
  const subscriptionId = context.run.modelSubscriptionId
  const epoch = context.run.modelSubscriptionEpoch
  if (!subscriptionId || epoch === undefined || epoch === null) return

  const providerKey = parseSubscriptionProviderColumn(context.agent.provider ?? '')
  if (!providerKey) return

  const status = statusFromError(input.error)
  if (!status) return

  try {
    const adapter = requireSubscriptionAdapter(providerKey)
    const kind = adapter.classifyFailure({ status })
    await recordSubscriptionFailure(
      { prisma: deps.prisma, secretStore: deps.subscriptionSecrets ?? null },
      {
        detail: input.messageText.slice(0, 500),
        epoch,
        kind,
        subscriptionId,
      },
    )
  } catch (error) {
    console.error(
      `[worker] failed to record subscription failure for run ${context.run.id}`,
      error,
    )
  }
}

export const noteSubscriptionSuccess = async (
  deps: ExecutionDependencies,
  context: RunContext,
): Promise<void> => {
  const subscriptionId = context.run.modelSubscriptionId
  const epoch = context.run.modelSubscriptionEpoch
  if (!subscriptionId || epoch === undefined || epoch === null) return

  try {
    await recordSubscriptionSuccess(
      { prisma: deps.prisma, secretStore: deps.subscriptionSecrets ?? null },
      { epoch, subscriptionId },
    )
  } catch (error) {
    console.error(
      `[worker] failed to record subscription success for run ${context.run.id}`,
      error,
    )
  }
}

import {
  ModelSubscriptionError,
  loadSpendableSubscription,
  looksLikeSubscriptionProviderColumn,
  parseSubscriptionProviderColumn,
  requireSubscriptionAdapter,
} from '@nessie/model-subscriptions'
import type { ExecutionDependencies, RunContext } from './types.js'

/**
 * Which purse this run spends, decided ONCE at admission.
 *
 * Pinning matters because `resolveStageProviderConfig` runs for every inference
 * call in a run: without a pin, a relink between two loop iterations would
 * silently move the second half of a run onto a different credential — or a
 * different account entirely. The resolved subscription and its credential
 * generation are persisted on the `Run`, so a continuation or restart re-enters
 * the same lane and fails closed when that binding is no longer valid.
 *
 * Spec: docs/plans/2026-09-02-personal-model-subscriptions.md §2.4.
 */
export type RunSubscriptionBinding = {
  subscriptionId: string
  epoch: number
  providerKey: string
  ownerUserId: string
}

export type RunSubscriptionResolution =
  | { kind: 'ledger' }
  | { kind: 'subscription'; binding: RunSubscriptionBinding }
  | { kind: 'unavailable'; reason: string }

/**
 * Resolve the run's lane from the agent's persisted selection.
 *
 * Two properties are deliberate. First, a selection that merely LOOKS like a
 * subscription (a newer replica's adapter, a retired one, a dangling pointer
 * after a disconnect) resolves to `unavailable`, never to Ledger: falling back
 * would move a person's spend onto the organization without anyone agreeing to
 * it. Second, entitlement is re-derived here from the live rows — the agent's
 * owner, that owner's live membership, the subscription's status — because the
 * write-time validator is UX and this is the gate.
 */
export const resolveRunSubscriptionBinding = async (
  deps: ExecutionDependencies,
  context: RunContext,
): Promise<RunSubscriptionResolution> => {
  const provider = context.agent.provider
  if (!looksLikeSubscriptionProviderColumn(provider)) return { kind: 'ledger' }

  const subscriptionId = context.agent.modelSubscriptionId ?? null
  if (!subscriptionId) {
    return {
      kind: 'unavailable',
      reason: 'This agent is set to run on a personal subscription that is no longer linked',
    }
  }

  const providerKey = parseSubscriptionProviderColumn(provider)
  if (!providerKey) {
    return {
      kind: 'unavailable',
      reason: 'This agent is set to run on a subscription provider this deployment does not support',
    }
  }

  const ownerUserId = context.agent.ownerUserId ?? null
  if (!ownerUserId) {
    return {
      kind: 'unavailable',
      reason: 'This agent has no owner, so it cannot run on a personal subscription',
    }
  }

  try {
    const subscription = await loadSpendableSubscription(
      { prisma: deps.prisma, secretStore: deps.subscriptionSecrets ?? null },
      {
        expectedOwnerUserId: ownerUserId,
        organizationId: context.channel.organizationId,
        subscriptionId,
      },
    )
    if (subscription.provider !== providerKey) {
      return {
        kind: 'unavailable',
        reason: 'This agent’s model and personal subscription no longer match',
      }
    }
    // Proves the adapter is present in THIS process before the run is admitted,
    // so a rolling deploy fails at the gate rather than mid-conversation.
    requireSubscriptionAdapter(subscription.provider)
    return {
      binding: {
        epoch: subscription.credentialEpoch,
        ownerUserId,
        providerKey: subscription.provider,
        subscriptionId: subscription.id,
      },
      kind: 'subscription',
    }
  } catch (error) {
    if (error instanceof ModelSubscriptionError) {
      return { kind: 'unavailable', reason: (error as Error).message.replace(/\.$/, '') }
    }
    throw error
  }
}

/** Persist the pin so continuations and restarts re-enter the same lane. */
export const persistRunSubscriptionBinding = async (
  deps: ExecutionDependencies,
  input: { runId: string; binding: RunSubscriptionBinding },
): Promise<void> => {
  await deps.prisma.run.update({
    data: {
      modelSubscriptionEpoch: input.binding.epoch,
      modelSubscriptionId: input.binding.subscriptionId,
    },
    where: { id: input.runId },
  })
}

/**
 * The member-facing remedy. Deliberately says who can fix it rather than
 * offering a fix nobody reading it can perform: only the owner can relink.
 */
export const subscriptionUnavailableNotice = (input: {
  reason: string
  isOwnerViewing: boolean
  ownerName?: string | null
}): string =>
  input.isOwnerViewing
    ? `${input.reason}. Reconnect it in Settings → Connections.`
    : `${input.reason}. ${input.ownerName ? `Ask ${input.ownerName}` : 'Ask its owner'} to reconnect it.`

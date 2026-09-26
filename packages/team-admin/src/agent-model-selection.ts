import type { PrismaClient } from '@prisma/client'
import type { ModelConfig } from '@nessie/config'
import {
  listUserSubscriptions,
  parseSubscriptionProviderColumn,
  requireSubscriptionAdapter,
  looksLikeSubscriptionProviderColumn,
} from '@nessie/model-subscriptions'
import {
  isModelPairDisabled,
  loadDisabledModelPairs,
  loadDisabledTeamModelPairs,
} from './inference-model-availability.js'
import {
  assertLedgerAgentModelSelection,
  LedgerAgentModelCatalogError,
  LEDGER_AGENT_MODEL_CATALOG_ERROR_CODES,
} from './ledger-agent-model-catalog.js'

/**
 * The ONE validator every agent write path uses — create, update, clone, and
 * the personal-assistant `agent_create` tool alike.
 *
 * It exists because the selection now has two arms. A Ledger pair is checked
 * against the deployment's catalogue exactly as before; a `subscription/<key>`
 * pair is checked against the *acting person's* own links. Forking that
 * decision per call site is how one path would end up accepting a selection
 * another refuses.
 *
 * Write-time validation is UX, not security: the run-time gate re-derives
 * ownership and liveness on every dispatch and fails closed. This is what stops
 * a person selecting something that cannot work, not what stops them spending
 * somebody else's plan.
 *
 * Spec: docs/plans/2026-09-02-personal-model-subscriptions.md §2.3.
 */

export type AgentModelSelectionInput = {
  /** The resulting pair after the write, not the patch. */
  model: string | null | undefined
  provider: string | null | undefined
  /** Explicit subscription pointer for a subscription selection. */
  modelSubscriptionId?: string | null | undefined
  organizationId: string
  /** Who is performing the write. A subscription must be theirs. */
  actingUserId: string | null | undefined
  /** Who will own the agent afterwards; defaults to the acting user. */
  ownerUserId?: string | null | undefined
  /**
   * The pair this agent is on BEFORE the write, when there is one.
   *
   * It exists so an organisation disabling a model cannot brick every other
   * edit of the agents already on it. Disabling takes effect on *new*
   * selections; an agent already pinned keeps running and keeps being
   * editable, and the Agent Designer says so where the person is standing.
   * Omit it on create, which has no previous pair and is therefore always
   * checked. See docs/standards/inference-model-availability.md.
   */
  previousSelection?: { model: string | null | undefined; provider: string | null | undefined }
  /** Team policy further narrows its organisation's allowed Ledger pairs. */
  teamId?: string | null | undefined
}

export type AgentModelSelectionResult = {
  /** Normalized pointer to persist. Null clears any previous selection. */
  modelSubscriptionId: string | null
}

export class AgentModelSelectionError extends Error {
  override readonly name = 'AgentModelSelectionError'

  constructor(readonly code: string, message: string) {
    super(message)
  }
}

export const AGENT_MODEL_SELECTION_ERROR_CODES = {
  NOT_LINKED: 'AGENT_MODEL_SUBSCRIPTION_NOT_LINKED',
  NOT_OWNER: 'AGENT_MODEL_SUBSCRIPTION_NOT_OWNER',
  UNKNOWN_MODEL: 'AGENT_MODEL_SUBSCRIPTION_UNKNOWN_MODEL',
  UNKNOWN_PROVIDER: 'AGENT_MODEL_SUBSCRIPTION_UNKNOWN_PROVIDER',
  DISABLED: 'AGENT_MODEL_DISABLED_FOR_ORGANIZATION',
  TEAM_DISABLED: 'AGENT_MODEL_DISABLED_FOR_TEAM',
} as const

/**
 * An organisation owner switched this pair off on
 * `/admin/models`. Refused here so the switch is real at every
 * write path — the picker already hides it, and a picker-only filter would be
 * bypassed by the personal assistant's `agent_create` tool and by any client
 * posting the pair directly.
 */
const assertPairEnabled = async (
  prisma: PrismaClient,
  input: {
    model: string
    organizationId: string
    previousSelection: AgentModelSelectionInput['previousSelection']
    provider: string
    teamId: string | null | undefined
  },
): Promise<void> => {
  const unchanged =
    input.previousSelection?.provider?.trim() === input.provider
    && input.previousSelection?.model?.trim() === input.model
  if (unchanged) return

  const disabled = await loadDisabledModelPairs(prisma, input.organizationId)
  if (isModelPairDisabled(disabled, input.provider, input.model)) {
    throw new AgentModelSelectionError(
      AGENT_MODEL_SELECTION_ERROR_CODES.DISABLED,
      'That model is switched off for this organisation. '
        + 'An organisation owner can turn it back on under Admin › AI models.',
    )
  }
  if (input.teamId) {
    const teamDisabled = await loadDisabledTeamModelPairs(prisma, input.teamId)
    if (isModelPairDisabled(teamDisabled, input.provider, input.model)) {
      throw new AgentModelSelectionError(
        AGENT_MODEL_SELECTION_ERROR_CODES.TEAM_DISABLED,
        'That model is switched off for this team. '
          + 'A team administrator can turn it back on under Admin › AI models, in this team\'s scope.',
      )
    }
  }
}

export const assertAgentModelSelection = async (
  prisma: PrismaClient,
  input: AgentModelSelectionInput & {
    config: Pick<ModelConfig, 'apiKey' | 'baseUrl'>
    ledgerPublicUrl?: string
    requestHeaders?: Record<string, string>
  },
): Promise<AgentModelSelectionResult> => {
  const provider = input.provider?.trim() || null
  const model = input.model?.trim() || null

  if (!looksLikeSubscriptionProviderColumn(provider)) {
    if (provider !== null || model !== null) {
      await assertLedgerAgentModelSelection({
        config: input.config,
        ...(input.ledgerPublicUrl ? { ledgerPublicUrl: input.ledgerPublicUrl } : {}),
        model: model ?? undefined,
        provider: provider ?? undefined,
        ...(input.requestHeaders ? { requestHeaders: input.requestHeaders } : {}),
      })
    }
    if (provider && model) {
      await assertPairEnabled(prisma, {
        model,
        organizationId: input.organizationId,
        previousSelection: input.previousSelection,
        provider,
        teamId: input.teamId,
      })
    }
    // A Ledger selection clears any previous subscription pointer, so the two
    // can never disagree about which lane this agent runs on.
    return { modelSubscriptionId: null }
  }

  const providerKey = parseSubscriptionProviderColumn(provider)
  if (!providerKey) {
    throw new AgentModelSelectionError(
      AGENT_MODEL_SELECTION_ERROR_CODES.UNKNOWN_PROVIDER,
      'That personal subscription provider is not available on this deployment.',
    )
  }
  if (!model) {
    throw new AgentModelSelectionError(
      AGENT_MODEL_SELECTION_ERROR_CODES.UNKNOWN_MODEL,
      'Choose a model for this subscription.',
    )
  }

  const adapter = requireSubscriptionAdapter(providerKey)
  if (!adapter.models.some((option) => option.model === model)) {
    throw new AgentModelSelectionError(
      AGENT_MODEL_SELECTION_ERROR_CODES.UNKNOWN_MODEL,
      `${adapter.displayName} does not offer that model.`,
    )
  }

  // A subscription is spent by the agent's OWNER, so the owner is who must have
  // linked it. Defaulting to the acting user covers create, where the acting
  // person becomes the owner in the same transaction.
  const ownerUserId = input.ownerUserId ?? input.actingUserId ?? null
  if (!ownerUserId) {
    throw new AgentModelSelectionError(
      AGENT_MODEL_SELECTION_ERROR_CODES.NOT_OWNER,
      'An agent must have an owner before it can run on a personal subscription.',
    )
  }
  if (input.actingUserId && ownerUserId !== input.actingUserId) {
    throw new AgentModelSelectionError(
      AGENT_MODEL_SELECTION_ERROR_CODES.NOT_OWNER,
      'Only the agent’s owner can put it on their own personal subscription.',
    )
  }

  const subscriptions = await listUserSubscriptions(
    { prisma, secretStore: null },
    { organizationId: input.organizationId, userId: ownerUserId },
  )
  const forProvider = subscriptions.filter((row) => row.provider === providerKey)
  if (forProvider.length === 0) {
    throw new AgentModelSelectionError(
      AGENT_MODEL_SELECTION_ERROR_CODES.NOT_LINKED,
      `Link a ${adapter.displayName} subscription before selecting its models.`,
    )
  }

  // Two linked accounts at one provider must be told apart explicitly. Picking
  // "the most recent" would silently spend the wrong account — the same
  // ambiguity the comms coordinator refuses rather than guesses.
  const requested = input.modelSubscriptionId?.trim() || null
  if (requested) {
    const match = forProvider.find((row) => row.id === requested)
    if (!match) {
      throw new AgentModelSelectionError(
        AGENT_MODEL_SELECTION_ERROR_CODES.NOT_LINKED,
        'That personal subscription is not linked to this account.',
      )
    }
    return { modelSubscriptionId: match.id }
  }
  if (forProvider.length > 1) {
    throw new AgentModelSelectionError(
      AGENT_MODEL_SELECTION_ERROR_CODES.NOT_LINKED,
      `Choose which ${adapter.displayName} account this agent should use.`,
    )
  }
  return { modelSubscriptionId: forProvider[0]?.id ?? null }
}

export const isLedgerCatalogUnavailable = (error: unknown): boolean =>
  error instanceof LedgerAgentModelCatalogError
  && error.code !== LEDGER_AGENT_MODEL_CATALOG_ERROR_CODES.MODEL_NOT_AVAILABLE

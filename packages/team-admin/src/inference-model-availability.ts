import type { PrismaClient } from '@prisma/client'

/**
 * Which Ledger provider/model pairs an organisation owner has switched OFF.
 *
 * The deployment's catalogue is Ledger's, not Nessie's: "every model available
 * in the deployment" is whatever Ledger offers, and nothing local enumerates
 * it. So availability is stored as an **exception list** rather than an
 * allow-list — an `inference_models` row exists for a pair only once somebody
 * has had an opinion about it, and `enabled = false` is that opinion.
 *
 * Absent row ⇒ available. That is what makes the page safe to ship against a
 * catalogue that grows without anybody's involvement: a model Ledger adds
 * tomorrow is usable tomorrow, not invisible until an owner notices it.
 *
 * The same rows are read by the worker's org-provider override path
 * (`worker/src/run/inference-provider.ts`), which requires
 * `enabled = true AND lifecycle_status = 'approved'` before an override
 * applies. Those two readings do not collide: a row this module writes is
 * created as a `draft` container, so it can never switch a run's destination —
 * it only ever answers "may this pair be selected?". See
 * docs/standards/inference-model-availability.md.
 */

export const MODEL_PAIR_SEPARATOR = '\u0000'

export const modelPairKey = (provider: string, model: string): string =>
  `${provider}${MODEL_PAIR_SEPARATOR}${model}`

export type DisabledModelPairs = ReadonlySet<string>
export type ModelAvailabilityDecisions = ReadonlyMap<string, boolean>

/**
 * Every pair this organisation has explicitly disabled.
 *
 * Deliberately one query returning the whole exception list rather than a
 * per-pair existence check: the picker has to filter a few hundred catalogue
 * entries in one pass, and the set is small by construction — it holds only
 * the pairs an owner has actually touched.
 */
export const loadDisabledModelPairs = async (
  prisma: PrismaClient,
  organizationId: string,
): Promise<Set<string>> => {
  const rows = await prisma.inferenceModel.findMany({
    select: { model: true, provider: { select: { providerKey: true } } },
    where: { enabled: false, organizationId },
  })
  return new Set(rows.map((row) => modelPairKey(row.provider.providerKey, row.model)))
}

/**
 * Every local decision for one team, keyed by its Ledger provider/model pair.
 *
 * An absent row inherits the organisation's allowed state. A true row is
 * meaningful because it records that a team reversed its own earlier disable;
 * it never overrides an organisation-level disable, which callers check first.
 */
export const loadTeamModelAvailabilityDecisions = async (
  prisma: PrismaClient,
  teamId: string,
): Promise<Map<string, boolean>> => {
  const rows = await prisma.teamInferenceModelAvailability.findMany({
    select: { enabled: true, model: true, provider: true },
    where: { teamId },
  })
  return new Map(rows.map((row) => [modelPairKey(row.provider, row.model), row.enabled]))
}

/** Every pair this team explicitly disabled, not its inherited org exclusions. */
export const loadDisabledTeamModelPairs = async (
  prisma: PrismaClient,
  teamId: string,
): Promise<Set<string>> => {
  const rows = await prisma.teamInferenceModelAvailability.findMany({
    select: { model: true, provider: true },
    where: { enabled: false, teamId },
  })
  return new Set(rows.map((row) => modelPairKey(row.provider, row.model)))
}

export const isModelPairDisabled = (
  disabled: DisabledModelPairs,
  provider: string | null | undefined,
  model: string | null | undefined,
): boolean => {
  const providerKey = provider?.trim()
  const modelName = model?.trim()
  if (!providerKey || !modelName) return false
  return disabled.has(modelPairKey(providerKey, modelName))
}

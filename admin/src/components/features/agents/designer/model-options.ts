import type { AgentModelOption } from '../../../../lib/api-client'

export const modelOptionKey = (
  option: Pick<AgentModelOption, 'model' | 'provider'>,
): string => `${option.provider} ${option.model}`

/**
 * Which purse an option spends. Absent means the deployment's Ledger credits —
 * the shape every option had before personal subscriptions existed.
 */
export const modelOptionSource = (
  option: Pick<AgentModelOption, 'source'>,
): 'ledger' | 'subscription' => option.source ?? 'ledger'

export const modelOptionLabel = (option: AgentModelOption): string =>
  option.displayName === option.model
    ? option.model
    : `${option.displayName} (${option.model})`

// The model id repeats under the display name because that is the string the
// run actually sends to Ledger; the catalogue description follows it when the
// provider ships one.
export const modelOptionSubtitle = (option: AgentModelOption): string =>
  [
    option.displayName === option.model ? undefined : option.model,
    option.description,
    // Only when a person has linked two accounts at one provider does the
    // server send this; otherwise it would be noise beside every row.
    option.accountLabel,
  ]
    .filter(Boolean)
    .join(' — ')
  || option.providerDisplayName

/**
 * The form resolves its selected model by matching model AND provider against
 * the catalogue, so a pair that resolves to nothing — a model the Design
 * Assistant invented, or one Ledger has since withdrawn — is not a selection
 * at all. Callers apply the returned option, never the raw pair.
 */
export const findModelOption = (
  options: AgentModelOption[],
  model: string,
  provider: string,
): AgentModelOption | undefined =>
  options.find((option) => option.model === model && option.provider === provider)

/**
 * Every whitespace-separated term must match somewhere, so "openai mini" and
 * "mini openai" both land on the same model.
 */
export const filterModelOptions = (
  options: AgentModelOption[],
  query: string,
): AgentModelOption[] => {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return options
  return options.filter((option) => {
    const haystack = [
      option.displayName,
      option.model,
      option.providerDisplayName,
      option.description ?? '',
      option.accountLabel ?? '',
    ]
      .join(' ')
      .toLowerCase()
    return terms.every((term) => haystack.includes(term))
  })
}

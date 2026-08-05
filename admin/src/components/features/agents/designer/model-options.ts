import type { AgentModelOption } from '../../../../lib/api-client'

export const modelOptionKey = (
  option: Pick<AgentModelOption, 'model' | 'provider'>,
): string => `${option.provider} ${option.model}`

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
  ]
    .filter(Boolean)
    .join(' — ')
  || option.providerDisplayName

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
    ]
      .join(' ')
      .toLowerCase()
    return terms.every((term) => haystack.includes(term))
  })
}

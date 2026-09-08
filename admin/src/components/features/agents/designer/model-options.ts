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

/**
 * Picker order: a person's own linked subscriptions first, the Ledger
 * catalogue after them, each side keeping the order the server sent.
 *
 * The catalogue arrives Ledger-first and stays that way everywhere the order
 * carries meaning — the preselection a new agent gets, and the shortlist the
 * Design Assistant is shown — because a default must never move spend onto
 * somebody's personal plan. This is presentation only: a Ledger catalogue runs
 * to hundreds of models, and a person who linked their own plan had to scroll
 * past every one of them to reach the handful they pay for.
 */
export const orderModelOptionsForPicker = (
  options: AgentModelOption[],
): AgentModelOption[] => [
  ...options.filter((option) => modelOptionSource(option) === 'subscription'),
  ...options.filter((option) => modelOptionSource(option) !== 'subscription'),
]

/**
 * What a person actually typed into a field that was still showing the model
 * they had selected.
 *
 * The picker keeps the selected model's name in the field while the list is
 * open — blanking it back to the placeholder reads as having thrown the choice
 * away — so the first keystroke arrives as the whole name plus one character.
 * No caret trick can avoid that: the list opens over the field and swallows the
 * rest of the press, so a selection made on the way down is gone by the time
 * the person types. One insertion is simply the difference between the two
 * strings; deleting instead means "clear this and show me everything".
 */
export const readTypedQuery = (shown: string, next: string): string => {
  if (shown === '') return next
  if (next.length <= shown.length) return ''
  let prefix = 0
  while (prefix < shown.length && shown[prefix] === next[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < shown.length - prefix
    && shown[shown.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) suffix += 1
  return next.slice(prefix, next.length - suffix)
}

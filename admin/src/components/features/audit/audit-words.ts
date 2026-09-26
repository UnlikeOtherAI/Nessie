import type { PillTone } from '../../primitives/Pill'

/**
 * The trail's machine words, said the way the admin says them elsewhere.
 *
 * An action is a dotted code (`team.member_added`, `kb.page.updated`). The code
 * stays exact wherever it is the thing being compared — the entry's own page,
 * the export — but a row reads as words, in the admin's vocabulary rather than
 * the schema's: a knowledge page is a document, an executor a computer, a
 * secret a key, and the organisation is spelt the one way.
 */

const WORDS: Record<string, string> = {
  executor: 'computer',
  executors: 'computers',
  kb: 'document',
  mcp: 'app',
  organization: 'organisation',
  secret: 'key',
  secrets: 'keys',
}

export const auditActionLabel = (action: string): string => {
  const words = action
    .split(/[._]+/)
    .filter((word) => word.length > 0)
    .map((word) => WORDS[word] ?? word)
  const sentence = words.join(' ')
  return sentence ? `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}` : action
}

const OUTCOMES: Record<string, { label: string; tone: PillTone }> = {
  denied: { label: 'Refused', tone: 'warning' },
  error: { label: 'Failed', tone: 'danger' },
  success: { label: 'Succeeded', tone: 'success' },
}

/** An outcome the admin does not know yet still says what it is. */
export const auditOutcome = (outcome: string): { label: string; tone: PillTone } =>
  OUTCOMES[outcome] ?? { label: outcome, tone: 'muted' }

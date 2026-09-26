import type { AuditVerification } from '../../../facades/audit/hooks'

/**
 * Verify integrity, answered in a sentence.
 *
 * The chain walk checks the entries written since the hash chain existed; the
 * ones before it carry no hash. "All N verified" is only true of the N, so the
 * older entries are counted and said, never folded into the claim — and a
 * break says what kind of change it found and how far the trail is intact.
 */

export type AuditVerificationSentence = {
  /** The entry the walk stopped at, when it found a break. */
  brokenEntryId?: string
  detail?: string
  text: string
  tone: 'danger' | 'info' | 'success'
}

const count = (value: number): string => value.toLocaleString('en-GB')

const entries = (value: number): string => `${count(value)} ${value === 1 ? 'entry' : 'entries'}`

const olderNote = (unchained: number): string | undefined =>
  unchained > 0
    ? `${entries(unchained)} written before verification existed ${unchained === 1 ? 'has' : 'have'} no fingerprint and can’t be checked.`
    : undefined

const BREAKS: Record<string, string> = {
  broken_link: 'An entry was removed, added or reordered just before this one.',
  entry_hash_mismatch: 'This entry was changed after it was written.',
  unexpected_prev_hash: 'The first entry that can be checked points to one that isn’t there.',
}

export const auditVerificationSentence = (result: AuditVerification): AuditVerificationSentence => {
  const older = olderNote(result.unchainedCount)
  if (result.valid) {
    if (result.checkedCount === 0) {
      return result.unchainedCount > 0
        ? { text: `None of the ${entries(result.unchainedCount)} can be checked: they were written before verification existed.`, tone: 'info' }
        : { text: 'There are no entries to verify yet.', tone: 'info' }
    }
    const all = result.checkedCount === 1 ? 'The one entry' : `All ${entries(result.checkedCount)}`
    return {
      ...(older ? { detail: older } : {}),
      text: `${all} verified, none altered.`,
      tone: 'success',
    }
  }
  const reason = result.firstBreak ? BREAKS[result.firstBreak.reason] : undefined
  const intact = result.checkedCount > 0
    ? `The ${entries(result.checkedCount)} before it ${result.checkedCount === 1 ? 'is' : 'are'} intact.`
    : 'No entry before it could be confirmed.'
  return {
    ...(result.firstBreak ? { brokenEntryId: result.firstBreak.id } : {}),
    detail: [intact, older].filter(Boolean).join(' '),
    text: reason ?? 'The trail does not match what was recorded.',
    tone: 'danger',
  }
}

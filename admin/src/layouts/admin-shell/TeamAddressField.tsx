import { useEffect, useState } from 'react'

import { FormField } from '../../components/shared/FormField'
import { Input } from '../../components/shared/FormControls'
import {
  useSlugAvailability,
  type SlugUnavailableReason,
} from '../../facades/team/provisioning'

/**
 * The address a team or organisation will live at.
 *
 * **Nessie keeps no copy of the rules.** The labels belong to UnlikeOtherAI,
 * so every judgement — even "too short" — is UOA's answer relayed back, not a
 * local guess that could drift out of step with the authority that actually
 * decides. What is local is only the derivation below, which is cosmetic: a
 * suggestion that stops the moment somebody types their own.
 *
 * The field follows the name until it is touched, then stops. Most people never
 * think about the address, and for them typing a name should be the whole
 * interaction; but once it is theirs, overwriting it on the next keystroke of
 * the name would be exactly the silent substitution this feature removes.
 */

const DEBOUNCE_MS = 300

const REASON_COPY: Record<SlugUnavailableReason, string> = {
  taken: 'That address is already in use.',
  too_short: 'Use at least 2 characters.',
  too_long: 'Use at most 63 characters.',
  charset:
    'Use only letters, numbers and hyphens, starting and ending with a letter or number.',
  double_hyphen: 'Two hyphens in a row are not allowed.',
  all_digits: 'An address cannot be only numbers.',
  reserved: 'That address is reserved.',
}

/**
 * A cosmetic preview of what UOA would derive. Kept deliberately simple —
 * it never decides anything, so it cannot disagree with the authority in a way
 * that matters.
 */
const previewSlug = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '')

export const TeamAddressField = ({
  name,
  value,
  onChange,
  onUsableChange,
  scope,
  orgId,
  disabled,
}: {
  name: string
  value: string
  onChange: (value: string) => void
  onUsableChange: (usable: boolean) => void
  scope: 'organisation' | 'team'
  orgId?: string
  disabled?: boolean
}) => {
  const [touched, setTouched] = useState(false)
  const [debounced, setDebounced] = useState('')

  const derived = previewSlug(name)
  const effective = touched ? value : derived

  useEffect(() => {
    if (!touched && derived !== value) onChange(derived)
  }, [derived, touched, value, onChange])

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(effective), DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [effective])

  const { data, isFetching } = useSlugAvailability({
    slug: debounced,
    scope,
    ...(orgId ? { orgId } : {}),
    enabled: !disabled && debounced.length > 0,
  })

  // Unknown is not unavailable: if UOA cannot be reached the create attempt
  // itself is the real answer, and blocking on a failed hint would be worse.
  const usable = !effective || data?.available !== false
  useEffect(() => {
    onUsableChange(usable)
  }, [usable, onUsableChange])

  const status = (() => {
    if (!effective) return null
    if (isFetching || debounced !== effective) return { text: 'Checking availability…', bad: false }
    if (data?.available === true) return { text: 'Available', bad: false }
    if (data?.available === false) {
      return { text: REASON_COPY[data.reason ?? 'taken'], bad: true }
    }
    return null
  })()

  return (
    <FormField label="Address">
      <Input
        autoComplete="off"
        disabled={disabled}
        inputMode="url"
        maxLength={63}
        onChange={(event) => {
          setTouched(true)
          onChange(event.target.value.trim().toLowerCase())
        }}
        placeholder={scope === 'organisation' ? 'e.g. acme' : 'e.g. design'}
        spellCheck={false}
        value={effective}
      />
      <p
        aria-live="polite"
        className={`mt-1 text-xs ${status?.bad ? 'text-[color:var(--danger)]' : 'text-[color:var(--tx3)]'}`}
      >
        {status
          ? status.text
          : 'The web address for this. You can change it later.'}
      </p>
    </FormField>
  )
}

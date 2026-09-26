import { useEffect, useRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import type { ResolvedSetting, SettingScope } from '../../../facades/settings/hooks'
import { Notice } from '../../primitives/Notice'

/**
 * A control whose value an ancestor level has locked.
 *
 * The setting still shows what is in force — hiding it would leave a person
 * wondering where their browser came from — but it is greyed and inert, with
 * one sentence naming the level that decided. Anything else offers an edit the
 * server would refuse.
 *
 * The subtree is made `inert` through a ref rather than a JSX attribute: that
 * is what actually takes it out of tab order and out of the accessibility
 * tree. `pointer-events-none` alone would still let a keyboard user tab into
 * a control they cannot operate, and `aria-disabled` alone only announces it.
 */
export const ScopedSettingGate = ({
  children,
  setting,
}: {
  children: ReactNode
  setting: ResolvedSetting | undefined
}) => {
  const { t } = useTranslation('settings')
  const inertRef = useRef<HTMLDivElement | null>(null)
  const gated = Boolean(setting && !setting.canEdit)
  useEffect(() => {
    if (inertRef.current) inertRef.current.inert = gated
  }, [gated])

  if (!setting || setting.canEdit) return <>{children}</>

  const lockedAt = setting.lockedAtScope
  return (
    <div className="grid gap-3">
      <Notice tone="info">
        {lockedAt
          ? t('settingsGate.lockedAt', { scope: t(`settingsGate.scopes.${lockedAt}`).toLowerCase() })
          : t('settingsGate.locked')}
      </Notice>
      <div aria-disabled="true" className="opacity-60" ref={inertRef}>
        {children}
      </div>
    </div>
  )
}

/**
 * The switch an editable level uses to stop the levels below it overriding.
 * Absent where there is nothing below: a personal setting locks nobody.
 */
export const ScopedSettingLock = ({
  disabled,
  onChange,
  locked,
  scope,
}: {
  disabled?: boolean
  onChange: (locked: boolean) => void
  locked: boolean
  scope: SettingScope
}) => {
  const { t } = useTranslation('settings')
  if (scope === 'user') return null
  const below = t(scope === 'organization' ? 'settingsGate.teamsAndPeople' : 'settingsGate.people')
  return (
    <label className="flex items-start gap-2 text-sm text-[color:var(--tx2)]">
      <input
        checked={locked}
        className="mt-0.5"
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
      <span>
        {t('settingsGate.useEverywhere')}{' '}
        <span className="text-[color:var(--tx3)]">
          {t('settingsGate.cannotOverride', { below: below.toLowerCase() })}
        </span>
      </span>
    </label>
  )
}

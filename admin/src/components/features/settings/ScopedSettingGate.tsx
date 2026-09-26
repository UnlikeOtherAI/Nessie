import { useEffect, useRef, type ReactNode } from 'react'

import type { ResolvedSetting, SettingScope } from '../../../facades/settings/hooks'
import { Notice } from '../../primitives/Notice'

const SCOPE_LABEL: Record<SettingScope, string> = {
  organization: 'organisation',
  team: 'team',
  user: 'personal',
}

/**
 * A control somebody with more standing could use: still on screen, greyed
 * and inert, with one sentence saying who can change it (the plan's R9, which
 * is this rule extended to every gate). A null reason leaves it as it is.
 *
 * The subtree is made `inert` through a ref rather than a JSX attribute: that
 * is what actually takes it out of tab order and out of the accessibility
 * tree. `pointer-events-none` alone would still let a keyboard user tab into
 * a control they cannot operate, and `aria-disabled` alone only announces it.
 */
export const InertGate = ({ children, reason }: { children: ReactNode; reason: string | null }) => {
  const inertRef = useRef<HTMLDivElement | null>(null)
  const gated = reason !== null
  useEffect(() => {
    if (inertRef.current) inertRef.current.inert = gated
  }, [gated])

  if (reason === null) return <>{children}</>

  return (
    <div className="grid gap-3">
      <Notice tone="info">{reason}</Notice>
      <div aria-disabled="true" className="opacity-60" ref={inertRef}>
        {children}
      </div>
    </div>
  )
}

/** Why a level above makes this one read-only, or null while it may edit. */
export const scopedSettingLockReason = (setting: ResolvedSetting | undefined): string | null => {
  if (!setting || setting.canEdit) return null
  return setting.lockedAtScope
    ? `This has been set at the ${SCOPE_LABEL[setting.lockedAtScope]} level and cannot be changed here.`
    : 'This cannot be changed here.'
}

/**
 * A control whose value an ancestor level has locked.
 *
 * The setting still shows what is in force — hiding it would leave a person
 * wondering where their browser came from — but it is greyed and inert, with
 * one sentence naming the level that decided. Anything else offers an edit the
 * server would refuse.
 */
export const ScopedSettingGate = ({
  children,
  setting,
}: {
  children: ReactNode
  setting: ResolvedSetting | undefined
}) => <InertGate reason={scopedSettingLockReason(setting)}>{children}</InertGate>

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
  if (scope === 'user') return null
  const below = scope === 'organization' ? 'Teams and people' : 'People'
  const scopeName = scope === 'organization' ? 'this organisation' : 'this team'
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
        Prevent overrides below {scopeName}.{' '}
        <span className="text-[color:var(--tx3)]">
          {below} below cannot choose their own; the control is greyed out for them with an
          explanation.
        </span>
      </span>
    </label>
  )
}

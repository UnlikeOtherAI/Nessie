import type { ResolvedSetting } from '../../../facades/settings/hooks'
import type { PillTone } from '../../primitives/Pill'

export type InheritanceChip = { label: string; tone: PillTone }

/**
 * Where a team's value of a scoped setting comes from, and which level locked
 * it, as chips — the scope pattern's inheritance words
 * (docs/plans/2026-09-26-admin-ux-overhaul.md §6.8) over the very answer
 * `ScopedSettingGate` greys a control from: `setAtScope` and `lockedAtScope`
 * resolved at the team level.
 *
 * A lock-only row carries no value, so a setting can be locked without being
 * set; each chip is read from its own field and the two never imply each
 * other. Nothing set anywhere earns no chip: the value sentence beside it
 * already says what the default is.
 */
export const teamInheritanceChips = (setting: ResolvedSetting | undefined): InheritanceChip[] => {
  if (!setting) return []
  const chips: InheritanceChip[] = []
  if (setting.setAtScope === 'organization') chips.push({ label: 'Set by organisation', tone: 'muted' })
  if (setting.setAtScope === 'team') chips.push({ label: 'Set by this team', tone: 'info' })
  if (setting.lockedAtScope === 'organization') chips.push({ label: 'Locked by organisation', tone: 'warning' })
  if (setting.lockedAtScope === 'team') chips.push({ label: 'Locked by this team', tone: 'outline' })
  return chips
}

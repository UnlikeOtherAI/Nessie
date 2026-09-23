import {
  DEEP_WATER_BRIEF_SETTING_KEYS,
  DEEP_WATER_DEFAULT_BRIEF_SETTINGS,
  DeepWaterBriefSettingsSchema,
  type DeepWaterBriefSettingKey,
  type DeepWaterBriefSettings,
  type DeepWaterBriefSettingsEdit,
  type DeepWaterBriefView,
} from '@nessie/schemas'
import { SETTING_LABEL } from './research-presentation'

/**
 * A person's unsent changes to a brief (amendments-fable F8). Edits are local
 * until they ride on the next reply or on Start (contract D4): a setting the
 * person sets is sent — and so locked against the planner — only if it
 * differs from what DeepWater already holds, and pillars are sent as a whole
 * new list only if the list changed. Pure, so the dialog's rules are tested
 * without a DOM.
 */

type SettingValue<K extends DeepWaterBriefSettingKey> = DeepWaterBriefSettings[K]

export type SettingEdits = { [K in DeepWaterBriefSettingKey]?: SettingValue<K> | null }

export type BriefEdits = {
  /** The whole pillar list as the person wrote it, blank rows included. */
  pillars?: string[]
  /** A value sets the key and locks it; null hands it back to DeepWater. */
  settings?: SettingEdits
}

export const NO_EDITS: BriefEdits = {}

type BriefState = Pick<DeepWaterBriefView, 'lockedSettings' | 'pillars' | 'settings'>

export const PILLAR_MAX_LENGTH = 500
export const PILLARS_MAX = 60

const serverSettings = (brief: BriefState): DeepWaterBriefSettings =>
  brief.settings ?? DEEP_WATER_DEFAULT_BRIEF_SETTINGS

const sameValue = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right)

const cleanPillars = (pillars: readonly string[]): string[] =>
  pillars.map((pillar) => pillar.trim()).filter((pillar) => pillar.length > 0)

export type EffectiveBrief = {
  /** Keys the person changed and has not sent yet. */
  editedKeys: ReadonlySet<DeepWaterBriefSettingKey>
  /** Keys DeepWater's planner may not change, counting unsent edits. */
  locked: ReadonlySet<DeepWaterBriefSettingKey>
  pillars: string[]
  pillarsEdited: boolean
  settings: DeepWaterBriefSettings
}

/** The brief as the person sees it: DeepWater's, with their unsent edits on top. */
export const effectiveBrief = (brief: BriefState, edits: BriefEdits): EffectiveBrief => {
  const settings = { ...serverSettings(brief) }
  const locked = new Set(brief.lockedSettings)
  const editedKeys = new Set<DeepWaterBriefSettingKey>()
  for (const key of DEEP_WATER_BRIEF_SETTING_KEYS) {
    if (!edits.settings || !Object.prototype.hasOwnProperty.call(edits.settings, key)) continue
    const value = edits.settings[key]
    if (value === undefined) continue
    editedKeys.add(key)
    if (value === null) {
      locked.delete(key)
    } else {
      ;(settings as Record<DeepWaterBriefSettingKey, unknown>)[key] = value
      locked.add(key)
    }
  }
  return {
    editedKeys,
    locked,
    pillars: edits.pillars ?? brief.pillars,
    pillarsEdited: edits.pillars !== undefined,
    settings,
  }
}

/** What is wrong with the pillars as written, or null. Blank rows are ignored. */
export const pillarsProblem = (pillars: readonly string[]): string | null => {
  const cleaned = cleanPillars(pillars)
  if (cleaned.length === 0) return 'Add at least one pillar.'
  if (cleaned.length > PILLARS_MAX) return `A brief can have at most ${PILLARS_MAX} pillars.`
  if (cleaned.some((pillar) => pillar.length > PILLAR_MAX_LENGTH)) {
    return `Keep each pillar under ${PILLAR_MAX_LENGTH} characters.`
  }
  return null
}

/** Does this setting edit change anything DeepWater holds? */
const settingEditMatters = (
  brief: BriefState,
  key: DeepWaterBriefSettingKey,
  value: unknown,
): boolean => {
  const isLocked = brief.lockedSettings.includes(key)
  if (value === null) return isLocked
  return !isLocked || !sameValue(serverSettings(brief)[key], value)
}

export type EditsPayload = {
  pillars?: string[]
  settings?: DeepWaterBriefSettingsEdit
}

/**
 * The edits to send with a reply or Start: only what differs from the brief
 * DeepWater holds, because every setting key sent becomes a lock. Empty when
 * nothing would change. Pillars that fail `pillarsProblem` are the caller's to
 * refuse before sending.
 */
export const editsPayload = (brief: BriefState, edits: BriefEdits): EditsPayload => {
  const payload: EditsPayload = {}
  if (edits.pillars !== undefined) {
    const cleaned = cleanPillars(edits.pillars)
    if (!sameValue(cleaned, brief.pillars)) payload.pillars = cleaned
  }
  const settings: Record<string, unknown> = {}
  for (const key of DEEP_WATER_BRIEF_SETTING_KEYS) {
    const value = edits.settings?.[key]
    if (value === undefined) continue
    if (settingEditMatters(brief, key, value)) settings[key] = value
  }
  if (Object.keys(settings).length > 0) payload.settings = settings as DeepWaterBriefSettingsEdit
  return payload
}

export const payloadHasEdits = (payload: EditsPayload): boolean =>
  payload.pillars !== undefined || payload.settings !== undefined

/** How many pillars Start would send: the person's own list if they wrote one. */
export const pillarCountForStart = (brief: BriefState, edits: BriefEdits): number =>
  edits.pillars !== undefined ? cleanPillars(edits.pillars).length : brief.pillars.length

export type Rebase = {
  /** What DeepWater changed underneath the person, in words, for "what changed". */
  changed: string[]
  /** The person's edits that still change something. */
  edits: BriefEdits
}

/**
 * The brief moved on while the person was editing — the planner answered, or
 * a Start or reply was refused as a revision conflict. Their edits are kept on
 * top of the new brief (they are explicit choices), minus any that the new
 * brief already matches, and the dialog says what DeepWater changed.
 */
export const rebaseEdits = (previous: BriefState, next: BriefState, edits: BriefEdits): Rebase => {
  const changed: string[] = []
  if (!sameValue(previous.pillars, next.pillars)) changed.push('the pillars')
  const before = serverSettings(previous)
  const after = serverSettings(next)
  for (const key of DEEP_WATER_BRIEF_SETTING_KEYS) {
    if (!sameValue(before[key], after[key])) changed.push(SETTING_LABEL[key].toLowerCase())
  }

  const rebased: BriefEdits = {}
  if (edits.pillars !== undefined && !sameValue(cleanPillars(edits.pillars), next.pillars)) {
    rebased.pillars = edits.pillars
  }
  const settings: SettingEdits = {}
  for (const key of DEEP_WATER_BRIEF_SETTING_KEYS) {
    const value = edits.settings?.[key]
    if (value === undefined || !settingEditMatters(next, key, value)) continue
    ;(settings as Record<string, unknown>)[key] = value
  }
  if (Object.keys(settings).length > 0) rebased.settings = settings
  return { changed, edits: rebased }
}

export const hasLocalEdits = (edits: BriefEdits): boolean =>
  edits.pillars !== undefined || Object.keys(edits.settings ?? {}).length > 0

/**
 * Set one setting locally. Choosing the value DeepWater already holds for a key
 * it still decides is no change at all, so it forgets the edit rather than
 * locking the planner out of a choice the person did not make.
 */
export const withSettingEdit = <K extends DeepWaterBriefSettingKey>(
  brief: BriefState,
  edits: BriefEdits,
  key: K,
  value: SettingValue<K> | null,
): BriefEdits => {
  const settings: SettingEdits = { ...edits.settings }
  const unchosen = value !== null
    && !brief.lockedSettings.includes(key)
    && sameValue(serverSettings(brief)[key], value)
  if (!unchosen && settingEditMatters(brief, key, value)) {
    ;(settings as Record<string, unknown>)[key] = value
  } else {
    delete settings[key]
  }
  const next: BriefEdits = { ...edits, settings }
  if (Object.keys(settings).length === 0) delete next.settings
  return next
}

/** Replace the pillar list locally; a list equal to DeepWater's forgets the edit. */
export const withPillarsEdit = (brief: BriefState, edits: BriefEdits, pillars: string[]): BriefEdits => {
  const next: BriefEdits = { ...edits }
  if (sameValue(pillars, brief.pillars)) delete next.pillars
  else next.pillars = pillars
  return next
}

/** Storage is untrusted input: keep only the two known fields, in their known shapes. */
export const reviveBriefEdits = (stored: unknown): BriefEdits => {
  if (!stored || typeof stored !== 'object') return NO_EDITS
  const record = stored as Record<string, unknown>
  const edits: BriefEdits = {}
  if (Array.isArray(record.pillars) && record.pillars.every((pillar) => typeof pillar === 'string')) {
    edits.pillars = record.pillars as string[]
  }
  if (record.settings && typeof record.settings === 'object' && !Array.isArray(record.settings)) {
    const settings: SettingEdits = {}
    for (const key of DEEP_WATER_BRIEF_SETTING_KEYS) {
      const value = (record.settings as Record<string, unknown>)[key]
      if (value === undefined) continue
      // A value from an older vocabulary would only be refused when sent.
      if (value === null || DeepWaterBriefSettingsSchema.shape[key].safeParse(value).success) {
        ;(settings as Record<string, unknown>)[key] = value
      }
    }
    if (Object.keys(settings).length > 0) edits.settings = settings
  }
  return edits
}

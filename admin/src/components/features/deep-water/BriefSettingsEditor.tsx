import type { ReactNode } from 'react'
import { faLock } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  DEEP_WATER_LANGUAGE_CODES,
  DEEP_WATER_OUTPUT_LANGUAGES,
  type DeepWaterBriefSettingKey,
  type DeepWaterBriefSettings,
} from '@nessie/schemas'
import { SectionLabel } from '../../primitives/SectionLabel'
import { ChoiceGroup } from '../../shared/ChoiceGroup'
import { Select } from '../../shared/FormControls'
import {
  CHAPTER_DEPTH_OPTIONS,
  DEPTH_OPTIONS,
  RECENCY_OPTIONS,
  SEARCH_QUALITY_OPTIONS,
  SETTING_LABEL,
  WRITING_STYLE_OPTIONS,
  depthLabel,
  languageName,
  sourceLanguagesLabel,
} from './research-presentation'

/**
 * The seven settings a brief negotiates (contract §3), with their UK English
 * labels. A setting the person chose is locked against the planner and shows
 * a lock; "Let DeepWater choose" hands it back. Output length is negotiated
 * through chapter detail — the output is always the full report — and
 * visibility is not a setting here (the person-only publish switch is).
 */

export type SettingChange = <K extends DeepWaterBriefSettingKey>(
  key: K,
  value: DeepWaterBriefSettings[K] | null,
) => void

type SettingsEditorProps = {
  editable: boolean
  editedKeys: ReadonlySet<DeepWaterBriefSettingKey>
  locked: ReadonlySet<DeepWaterBriefSettingKey>
  onChange: SettingChange
  settings: DeepWaterBriefSettings
}

const optionLabel = (options: readonly { label: string; value: string }[], value: string) =>
  options.find((option) => option.value === value)?.label ?? value

/** What the planner may and may not change, and whether the person's change is still unsent. */
const LockState = ({
  editable,
  edited,
  locked,
  onRelease,
}: {
  editable: boolean
  edited: boolean
  locked: boolean
  onRelease: () => void
}) => (
  <span className="flex flex-wrap items-center gap-2 text-xs text-[color:var(--tx3)]">
    {locked ? (
      <span className="flex items-center gap-1 text-[color:var(--tx2)]" data-testid="research-setting-locked">
        <FontAwesomeIcon aria-hidden="true" className="h-2.5 w-2.5" icon={faLock} />
        Your choice
      </span>
    ) : (
      <span>DeepWater chooses</span>
    )}
    {edited ? <span>· Not sent yet</span> : null}
    {editable && locked ? (
      <button className="underline" onClick={onRelease} type="button">Let DeepWater choose</button>
    ) : null}
  </span>
)

const SettingRow = ({
  children,
  settingKey,
  props,
}: {
  children: ReactNode
  props: SettingsEditorProps
  settingKey: DeepWaterBriefSettingKey
}) => (
  <div className="flex flex-col gap-1.5" data-setting={settingKey}>
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <span className="text-sm font-medium text-[color:var(--tx)]">{SETTING_LABEL[settingKey]}</span>
      <LockState
        editable={props.editable}
        edited={props.editedKeys.has(settingKey)}
        locked={props.locked.has(settingKey)}
        onRelease={() => props.onChange(settingKey, null)}
      />
    </div>
    {children}
  </div>
)

const SourceLanguages = ({ props }: { props: SettingsEditorProps }) => {
  const chosen = props.settings.languages
  if (!props.editable) {
    return <span className="text-sm text-[color:var(--tx2)]">{sourceLanguagesLabel(chosen)}</span>
  }
  const set = (next: DeepWaterBriefSettings['languages']) => props.onChange('languages', next)
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1.5">
        {chosen.length === 0 ? <span className="text-sm text-[color:var(--tx2)]">Any language</span> : null}
        {chosen.map((code) => (
          <button
            aria-label={`Remove ${languageName(code)}`}
            className="admin-button admin-button-secondary admin-button-compact"
            key={code}
            onClick={() => set(chosen.filter((entry) => entry !== code))}
            type="button"
          >
            {languageName(code)} ×
          </button>
        ))}
      </div>
      <Select
        aria-label="Add a source language"
        onChange={(event) => {
          const code = event.target.value as DeepWaterBriefSettings['languages'][number]
          if (code && !chosen.includes(code)) set([...chosen, code])
        }}
        size="compact"
        value=""
      >
        <option value="">Add a language…</option>
        {DEEP_WATER_LANGUAGE_CODES.filter((code) => !chosen.includes(code))
          .map((code) => ({ code, name: languageName(code) }))
          .sort((left, right) => left.name.localeCompare(right.name, 'en-GB'))
          .map(({ code, name }) => <option key={code} value={code}>{name}</option>)}
      </Select>
    </div>
  )
}

const pick = <K extends DeepWaterBriefSettingKey>(
  props: SettingsEditorProps,
  key: K,
  options: readonly { label: string; value: string }[],
) =>
  props.editable ? (
    <Select
      aria-label={SETTING_LABEL[key]}
      onChange={(event) => props.onChange(key, event.target.value as DeepWaterBriefSettings[K])}
      size="compact"
      value={String(props.settings[key])}
    >
      {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </Select>
  ) : (
    <span className="text-sm text-[color:var(--tx2)]">{optionLabel(options, String(props.settings[key]))}</span>
  )

const OUTPUT_LANGUAGE_OPTIONS = DEEP_WATER_OUTPUT_LANGUAGES.map((code) => ({
  label: languageName(code),
  value: code,
}))

export const BriefSettingsEditor = (props: SettingsEditorProps) => (
  <section aria-label="Settings" className="flex flex-col gap-4" data-testid="research-brief-settings">
    <h3><SectionLabel as="span" size="sm">Settings</SectionLabel></h3>
    <SettingRow props={props} settingKey="depth">
      {props.editable ? (
        <ChoiceGroup
          label={SETTING_LABEL.depth}
          labelHidden
          onChange={(value) => props.onChange('depth', value)}
          options={DEPTH_OPTIONS.map((option) => ({ label: option.label, value: option.value }))}
          value={props.settings.depth}
        />
      ) : (
        <span className="text-sm text-[color:var(--tx2)]">{depthLabel(props.settings.depth)}</span>
      )}
      <span className="text-xs text-[color:var(--tx3)]">
        {DEPTH_OPTIONS.find((option) => option.value === props.settings.depth)?.description}
      </span>
    </SettingRow>
    <SettingRow props={props} settingKey="chapterDepth">{pick(props, 'chapterDepth', CHAPTER_DEPTH_OPTIONS)}</SettingRow>
    <SettingRow props={props} settingKey="searchQuality">
      {pick(props, 'searchQuality', SEARCH_QUALITY_OPTIONS)}
    </SettingRow>
    <SettingRow props={props} settingKey="languages"><SourceLanguages props={props} /></SettingRow>
    <SettingRow props={props} settingKey="outputLanguage">
      {pick(props, 'outputLanguage', OUTPUT_LANGUAGE_OPTIONS)}
    </SettingRow>
    <SettingRow props={props} settingKey="recency">{pick(props, 'recency', RECENCY_OPTIONS)}</SettingRow>
    <SettingRow props={props} settingKey="writingStyle">{pick(props, 'writingStyle', WRITING_STYLE_OPTIONS)}</SettingRow>
  </section>
)

import { useEffect, useState } from 'react'
import type {
  DeepWaterResearchDepth,
  DeepWaterResearchLauncherPreset,
} from '../../../lib/api-client'
import {
  type DeepWaterResearchLaunchResponse,
  useLaunchDeepWaterResearch,
} from '../../../facades/integrations/hooks'
import {
  defaultDeepWaterResearchValues,
  deepWaterResearchLanguages,
  deepWaterResearchPresets,
  type DeepWaterResearchFormValues,
} from './deep-water-research-options'

const depthOptions: Array<{ label: string; value: DeepWaterResearchDepth }> = [
  { label: 'Light', value: 'light' },
  { label: 'Standard', value: 'standard' },
  { label: 'Deep', value: 'deep' },
  { label: 'Heavy', value: 'heavy' },
  { label: 'Thesis', value: 'thesis' },
  { label: 'Dissertation', value: 'dissertation' },
]

const boundedInt = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.trunc(Number.isFinite(value) ? value : min)))

const valuesFromPreset = (
  preset?: DeepWaterResearchLauncherPreset,
): DeepWaterResearchFormValues => ({
  ...defaultDeepWaterResearchValues,
  ...preset,
  query: preset?.query ?? '',
  title: preset?.title ?? '',
})

type DeepWaterResearchLauncherProps = {
  canLaunch: boolean
  initialValues?: DeepWaterResearchLauncherPreset
  onLaunched: (response: DeepWaterResearchLaunchResponse) => void
  readinessMessage?: string
  submitLabel?: string
}

// This is the single launcher form used in the Integrations tab and in chat.
// The server still validates every field and owns the authorization boundary;
// presets only make the user's already-approved choices easy to review/edit.
export const DeepWaterResearchLauncher = ({
  canLaunch,
  initialValues,
  onLaunched,
  readinessMessage,
  submitLabel = 'Run research',
}: DeepWaterResearchLauncherProps) => {
  const launch = useLaunchDeepWaterResearch()
  const [values, setValues] = useState<DeepWaterResearchFormValues>(() =>
    valuesFromPreset(initialValues),
  )
  const [presetId, setPresetId] = useState('balanced-research')

  useEffect(() => {
    setValues(valuesFromPreset(initialValues))
    setPresetId(initialValues ? 'chat-preset' : 'balanced-research')
  }, [initialValues])

  const updateValue = <Key extends keyof DeepWaterResearchFormValues>(
    key: Key,
    value: DeepWaterResearchFormValues[Key],
  ) => {
    setPresetId('custom')
    setValues((current) => ({ ...current, [key]: value }))
  }

  const applyPreset = (id: string) => {
    setPresetId(id)
    const preset = deepWaterResearchPresets.find((entry) => entry.id === id)
    if (!preset) {
      return
    }
    setValues((current) => ({ ...current, ...preset.values }))
  }

  const canSubmit = canLaunch && values.query.trim().length > 0 && !launch.isPending

  const submit = async () => {
    if (!canSubmit) {
      return
    }
    const response = await launch.mutateAsync({
      ...values,
      query: values.query.trim(),
      searchesPerPillar: boundedInt(values.searchesPerPillar, 1, 20),
      sections: boundedInt(values.sections, 3, 20),
      title: values.title.trim() || undefined,
    })
    onLaunched(response)
  }

  return (
    <div className="grid gap-4">
      <label className="grid gap-1 text-sm">
        <span className="font-semibold text-[var(--tx2)]">Research template</span>
        <select
          aria-label="Research template"
          className="admin-input"
          onChange={(event) => applyPreset(event.target.value)}
          value={presetId}
        >
          {initialValues ? <option value="chat-preset">Chat-provided preset</option> : null}
          {deepWaterResearchPresets.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label} — {preset.description}
            </option>
          ))}
          <option value="custom">Custom</option>
        </select>
      </label>

      <div className="grid gap-3">
        <label className="grid gap-1 text-sm">
          <span className="font-semibold text-[var(--tx2)]">Title</span>
          <input
            className="admin-input"
            maxLength={200}
            onChange={(event) => updateValue('title', event.target.value)}
            placeholder="Optional"
            value={values.title}
          />
        </label>

        <label className="grid gap-1 text-sm">
          <span className="font-semibold text-[var(--tx2)]">Research prompt</span>
          <textarea
            className="admin-input min-h-28"
            maxLength={5000}
            onChange={(event) => updateValue('query', event.target.value)}
            placeholder="What would you like Deep Water to investigate?"
            value={values.query}
          />
        </label>
      </div>

      <div>
        <div className="mb-2 text-sm font-semibold text-[var(--tx2)]">Depth</div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {depthOptions.map((option) => (
            <button
              aria-pressed={values.depth === option.value}
              className={[
                'h-9 rounded border px-2 text-xs font-semibold',
                values.depth === option.value
                  ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--thinking)]'
                  : 'border-[var(--sep)] text-[var(--tx2)] hover:bg-[var(--overlay)]',
              ].join(' ')}
              key={option.value}
              onClick={() => updateValue('depth', option.value)}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="grid gap-1 text-sm">
          <span className="font-semibold text-[var(--tx2)]">Chapter detail</span>
          <select
            className="admin-input"
            onChange={(event) =>
              updateValue(
                'chapterDepth',
                event.target.value as DeepWaterResearchFormValues['chapterDepth'],
              )
            }
            value={values.chapterDepth}
          >
            <option value="brief">Brief</option>
            <option value="standard">Standard</option>
            <option value="detailed">Detailed</option>
            <option value="exhaustive">Exhaustive</option>
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          <span className="font-semibold text-[var(--tx2)]">Output</span>
          <select
            className="admin-input"
            onChange={(event) =>
              updateValue('outputTier', event.target.value as DeepWaterResearchFormValues['outputTier'])
            }
            value={values.outputTier}
          >
            <option value="full">Full report</option>
            <option value="summary">Summary</option>
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          <span className="font-semibold text-[var(--tx2)]">Search quality</span>
          <select
            className="admin-input"
            onChange={(event) =>
              updateValue(
                'searchQuality',
                event.target.value as DeepWaterResearchFormValues['searchQuality'],
              )
            }
            value={values.searchQuality}
          >
            <option value="standard">Standard</option>
            <option value="premium">Premium</option>
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          <span className="font-semibold text-[var(--tx2)]">Recency</span>
          <select
            className="admin-input"
            onChange={(event) =>
              updateValue('recency', event.target.value as DeepWaterResearchFormValues['recency'])
            }
            value={values.recency}
          >
            <option value="any">Any time</option>
            <option value="day">Last day</option>
            <option value="week">Last week</option>
            <option value="month">Last month</option>
            <option value="year">Last year</option>
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          <span className="font-semibold text-[var(--tx2)]">Sections</span>
          <input
            className="admin-input"
            max={20}
            min={3}
            onChange={(event) => updateValue('sections', Number(event.target.value))}
            type="number"
            value={values.sections}
          />
        </label>
        <label className="grid gap-1 text-sm">
          <span className="font-semibold text-[var(--tx2)]">Searches per pillar</span>
          <input
            className="admin-input"
            max={20}
            min={1}
            onChange={(event) => updateValue('searchesPerPillar', Number(event.target.value))}
            type="number"
            value={values.searchesPerPillar}
          />
        </label>
        <label className="grid gap-1 text-sm">
          <span className="font-semibold text-[var(--tx2)]">Output language</span>
          <select
            className="admin-input"
            onChange={(event) => updateValue('outputLanguage', event.target.value)}
            value={values.outputLanguage}
          >
            {deepWaterResearchLanguages.map((language) => (
              <option key={language.code} value={language.code}>
                {language.label} ({language.code})
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          <span className="font-semibold text-[var(--tx2)]">Destination</span>
          <select
            className="admin-input"
            onChange={(event) =>
              updateValue(
                'artifactDestination',
                event.target.value as DeepWaterResearchFormValues['artifactDestination'],
              )
            }
            value={values.artifactDestination}
          >
            <option value="knowledge_draft">Knowledge draft</option>
            <option value="chat_only">Chat only</option>
          </select>
        </label>
      </div>

      {readinessMessage ? (
        <p className="rounded border border-[var(--warning-text)]/30 bg-[var(--warning-soft)] px-3 py-2 text-xs leading-5 text-[var(--warning-text)]">
          {readinessMessage}
        </p>
      ) : null}
      {launch.isError ? (
        <p className="text-xs text-[var(--danger-text)]" role="alert">
          {launch.error instanceof Error ? launch.error.message : 'Could not start research.'}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-3 border-t border-[var(--sep)] pt-3">
        <button
          className="admin-button admin-button-primary"
          disabled={!canSubmit}
          onClick={() => void submit()}
          type="button"
        >
          {launch.isPending ? 'Starting...' : submitLabel}
        </button>
      </div>
    </div>
  )
}

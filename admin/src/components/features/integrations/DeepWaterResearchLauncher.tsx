import { useEffect, useState } from 'react'
import type { DeepWaterResearchLauncherPreset } from '../../../lib/api-client'
import {
  type DeepWaterResearchLaunchResponse,
  useLaunchDeepWaterResearch,
} from '../../../facades/integrations/hooks'
import { Notice } from '../../primitives/Notice'
import { FormField } from '../../shared/FormField'
import { Textarea } from '../../shared/FormControls'
import {
  deepWaterResearchModes,
  deepWaterResearchValuesFromPreset,
  resolveDeepWaterResearchMode,
  type DeepWaterResearchFormValues,
  type DeepWaterResearchMode,
} from './deep-water-research-options'
import { DeepWaterResearchCustomControls } from './DeepWaterResearchCustomControls'
import { DeepWaterResearchModeSelector } from './DeepWaterResearchModeSelector'

const boundedInt = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.trunc(Number.isFinite(value) ? value : min)))

type DeepWaterResearchLauncherProps = {
  canLaunch: boolean
  initialValues?: DeepWaterResearchLauncherPreset
  onLaunched: (response: DeepWaterResearchLaunchResponse) => void
  readinessMessage?: string
  submitLabel?: string
}

// This is the single launcher form used in the Integrations tab and in chat.
// The question is the whole ask — no title is collected, because a report's own
// name belongs to Deep Water. Everything else is one choice: Light, Standard or
// Heavy assume a complete set of Ledger-accepted settings, and Custom reveals
// the full control set unchanged. The server still validates every field and
// owns the authorization boundary.
export const DeepWaterResearchLauncher = ({
  canLaunch,
  initialValues,
  onLaunched,
  readinessMessage,
  submitLabel = 'Run research',
}: DeepWaterResearchLauncherProps) => {
  const launch = useLaunchDeepWaterResearch()
  const [values, setValues] = useState<DeepWaterResearchFormValues>(() =>
    deepWaterResearchValuesFromPreset(initialValues),
  )
  const [mode, setMode] = useState<DeepWaterResearchMode>(() =>
    resolveDeepWaterResearchMode(deepWaterResearchValuesFromPreset(initialValues)),
  )

  useEffect(() => {
    const next = deepWaterResearchValuesFromPreset(initialValues)
    setValues(next)
    setMode(resolveDeepWaterResearchMode(next))
  }, [initialValues])

  const updateValue = <Key extends keyof DeepWaterResearchFormValues>(
    key: Key,
    value: DeepWaterResearchFormValues[Key],
  ) => {
    setValues((current) => ({ ...current, [key]: value }))
  }

  const selectMode = (next: DeepWaterResearchMode) => {
    setMode(next)
    const option = deepWaterResearchModes.find((entry) => entry.id === next)
    if (option) {
      setValues((current) => ({ ...option.values, query: current.query }))
    }
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
    })
    onLaunched(response)
  }

  return (
    <div className="grid gap-4">
      <FormField label="What do you want to research?">
        <Textarea
          className="min-h-28"
          maxLength={5000}
          onChange={(event) => updateValue('query', event.target.value)}
          placeholder="Ask the question you want answered, with any constraints that matter."
          value={values.query}
        />
      </FormField>

      <DeepWaterResearchModeSelector mode={mode} onSelect={selectMode} />

      {mode === 'custom' ? (
        <DeepWaterResearchCustomControls onChange={updateValue} values={values} />
      ) : null}

      {readinessMessage ? (
        <Notice size="sm" tone="warning">
          {readinessMessage}
        </Notice>
      ) : null}
      {launch.isError ? (
        <p className="text-xs text-[color:var(--danger-text)]" role="alert">
          {launch.error instanceof Error ? launch.error.message : 'Could not start research.'}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-3 border-t border-[color:var(--sep)] pt-3">
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

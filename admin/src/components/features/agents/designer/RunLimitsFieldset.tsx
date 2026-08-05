import type { RunLimitsField, RunLimitsFormState } from './run-limits'

type RunLimitField = {
  hint: string
  id: string
  key: RunLimitsField
  label: string
  placeholder: string
  // Duration accepts fractions of a minute; the counting dimensions are whole
  // numbers.
  step: string
}

const RUN_LIMIT_FIELDS: RunLimitField[] = [
  {
    hint: 'Total tokens the run may consume.',
    id: 'agent-run-limit-tokens',
    key: 'maxTokens',
    label: 'Max tokens',
    placeholder: 'No limit',
    step: '1',
  },
  {
    hint: 'Total tool calls across the run.',
    id: 'agent-run-limit-tool-calls',
    key: 'maxToolCalls',
    label: 'Max tool calls',
    placeholder: 'No limit',
    step: '1',
  },
  {
    hint: 'Think/act cycles before the run stops.',
    id: 'agent-run-limit-iterations',
    key: 'maxIterations',
    label: 'Max reasoning steps',
    placeholder: 'No limit',
    step: '1',
  },
  {
    hint: 'Wall-clock time the run may take.',
    id: 'agent-run-limit-duration',
    key: 'maxDurationMinutes',
    label: 'Max duration (minutes)',
    placeholder: 'No limit',
    step: 'any',
  },
  {
    hint: 'Spend ceiling for the run, in cents.',
    id: 'agent-run-limit-cost',
    key: 'maxCostCents',
    label: 'Max cost (cents)',
    placeholder: 'No limit',
    step: '1',
  },
]

type RunLimitsFieldsetProps = {
  labelClassName: string
  onChange: (field: RunLimitsField, value: string) => void
  value: RunLimitsFormState
}

/**
 * Optional explicit per-run caps (`Agent.runLimits`). Leaving a field blank is
 * the default and means that dimension is governed only by the deployment
 * backstop; clearing every field removes the agent's explicit limits entirely.
 */
export const RunLimitsFieldset = ({
  labelClassName,
  onChange,
  value,
}: RunLimitsFieldsetProps) => (
  <fieldset className="grid gap-1.5 border-0 p-0" data-testid="agent-run-limits">
    <legend className={labelClassName}>Run limits</legend>
    <p className="text-xs text-[color:var(--tx3)]">
      Optional ceilings for a single run. Leave a field blank for no explicit
      limit — the deployment backstop still applies.
    </p>
    <div className="grid gap-3 sm:grid-cols-2">
      {RUN_LIMIT_FIELDS.map((field) => (
        <div className="grid gap-1" key={field.key}>
          <label className="text-xs font-medium text-[color:var(--tx2)]" htmlFor={field.id}>
            {field.label}
          </label>
          <input
            autoComplete="off"
            className="admin-input"
            id={field.id}
            inputMode="decimal"
            min="0"
            onChange={(event) => onChange(field.key, event.target.value)}
            placeholder={field.placeholder}
            step={field.step}
            type="number"
            value={value[field.key]}
          />
          <span className="text-[11px] text-[color:var(--tx3)]">{field.hint}</span>
        </div>
      ))}
    </div>
  </fieldset>
)

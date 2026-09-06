import type { RunLimitsField, RunLimitsFormState } from '../../../../facades/designer/run-limits'
import { FormField } from '../../../shared/FormField'
import { Input } from '../../../shared/FormControls'

type RunLimitField = {
  hint: string
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
    key: 'maxTokens',
    label: 'Max tokens',
    placeholder: 'No limit',
    step: '1',
  },
  {
    hint: 'Total tool calls across the run.',
    key: 'maxToolCalls',
    label: 'Max tool calls',
    placeholder: 'No limit',
    step: '1',
  },
  {
    hint: 'Think/act cycles before the run stops.',
    key: 'maxIterations',
    label: 'Max reasoning steps',
    placeholder: 'No limit',
    step: '1',
  },
  {
    hint: 'Wall-clock time the run may take.',
    key: 'maxDurationMinutes',
    label: 'Max duration (minutes)',
    placeholder: 'No limit',
    step: 'any',
  },
  {
    hint: 'Spend ceiling for the run, in cents.',
    key: 'maxCostCents',
    label: 'Max cost (cents)',
    placeholder: 'No limit',
    step: '1',
  },
]

type RunLimitsFieldsetProps = {
  /**
   * Show the fields, not theirs to change. `<fieldset disabled>` is the
   * platform's own way to say it: every control inside inherits the disabled
   * state, so a field added later cannot forget to.
   */
  disabled?: boolean
  onChange: (field: RunLimitsField, value: string) => void
  value: RunLimitsFormState
}

/**
 * Optional explicit per-run caps (`Agent.runLimits`). Leaving a field blank is
 * the default and means that dimension is governed only by the deployment
 * backstop; clearing every field removes the agent's explicit limits entirely.
 *
 * The legend carries {@link FieldLabel}'s exact classes rather than importing
 * that component: a `<legend>` cannot be a `<label htmlFor>`, so this is the
 * one place that class string is legitimately written out a second time.
 */
export const RunLimitsFieldset = ({
  disabled = false,
  onChange,
  value,
}: RunLimitsFieldsetProps) => (
  <fieldset
    className="grid gap-1.5 border-0 p-0"
    data-testid="agent-run-limits"
    disabled={disabled}
  >
    <legend className="text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]">
      Run limits
    </legend>
    <p className="text-xs text-[color:var(--tx3)]">
      Optional ceilings for a single run. Leave a field blank for no explicit
      limit — the deployment backstop still applies.
    </p>
    <div className="grid gap-3 sm:grid-cols-2">
      {RUN_LIMIT_FIELDS.map((field) => (
        <FormField help={field.hint} key={field.key} label={field.label}>
          <Input
            autoComplete="off"
            inputMode="decimal"
            min="0"
            onChange={(event) => onChange(field.key, event.target.value)}
            placeholder={field.placeholder}
            step={field.step}
            type="number"
            value={value[field.key]}
          />
        </FormField>
      ))}
    </div>
  </fieldset>
)

import type { RunLimitsField, RunLimitsFormState } from '../../../../facades/designer/run-limits'
import { FormField } from '../../../shared/FormField'
import { Input } from '../../../shared/FormControls'

type RunLimitField = {
  hint: string
  key: RunLimitsField
  label: string
  placeholder: string
  // Minutes and dollars accept fractions; the counting dimensions are whole
  // numbers.
  step: string
}

// The two a person thinks in: how long a task may take and what it may cost.
const PLAIN_LIMITS: RunLimitField[] = [
  {
    hint: 'A task still running after this many minutes is stopped.',
    key: 'maxDurationMinutes',
    label: 'Stop a task after (minutes)',
    placeholder: 'No limit',
    step: 'any',
  },
  {
    hint: 'A task is stopped once its estimated cost reaches this many dollars.',
    key: 'maxCostDollars',
    label: 'Stop a task after (dollars of estimated cost)',
    placeholder: 'No limit',
    step: 'any',
  },
]

// The ones that need the model's own vocabulary, kept behind a fold.
const TECHNICAL_LIMITS: RunLimitField[] = [
  {
    hint: 'Words and pieces of words the model may read and write in one task.',
    key: 'maxTokens',
    label: 'Tokens',
    placeholder: 'No limit',
    step: '1',
  },
  {
    hint: 'Times one task may use a tool.',
    key: 'maxToolCalls',
    label: 'Tool uses',
    placeholder: 'No limit',
    step: '1',
  },
  {
    hint: 'Think-and-act cycles before the task stops.',
    key: 'maxIterations',
    label: 'Reasoning steps',
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

const LimitInput = ({
  field,
  onChange,
  value,
}: {
  field: RunLimitField
  onChange: RunLimitsFieldsetProps['onChange']
  value: RunLimitsFormState
}) => (
  <FormField help={field.hint} label={field.label}>
    <Input
      autoComplete="off"
      inputMode="decimal"
      min="0"
      onChange={(event) => onChange(field.key, event.target.value)}
      placeholder={field.placeholder}
      step={field.step}
      type="number"
      value={value[field.key] ?? ''}
    />
  </FormField>
)

/**
 * Optional explicit per-task limits (`Agent.runLimits`), in plain terms first:
 * minutes and dollars. Leaving a field blank is the default and means that
 * dimension is governed only by the deployment backstop; clearing every field
 * removes the agent's explicit limits entirely.
 *
 * The legend carries {@link FieldLabel}'s exact classes rather than importing
 * that component: a `<legend>` cannot be a `<label htmlFor>`, so this is the
 * one place that class string is legitimately written out a second time.
 */
export const RunLimitsFieldset = ({
  disabled = false,
  onChange,
  value,
}: RunLimitsFieldsetProps) => {
  // A limit already set behind the fold opens it, so nothing that governs the
  // agent is hidden from the person reading its settings.
  const technicalSet = TECHNICAL_LIMITS.some((field) => (value[field.key] ?? '').trim() !== '')
  return (
    <fieldset
      className="grid gap-1.5 border-0 p-0"
      data-testid="agent-run-limits"
      disabled={disabled}
    >
      <legend className="text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]">
        Run limits
      </legend>
      <p className="text-xs text-[color:var(--tx3)]">
        Optional. Leave a field blank for no limit of this agent’s own — the
        organisation’s limits still apply.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {PLAIN_LIMITS.map((field) => (
          <LimitInput field={field} key={field.key} onChange={onChange} value={value} />
        ))}
      </div>
      <details className="mt-1" open={technicalSet}>
        <summary className="cursor-pointer text-xs text-[color:var(--tx3)]">More limits</summary>
        <div className="mt-2 grid gap-3 sm:grid-cols-3">
          {TECHNICAL_LIMITS.map((field) => (
            <LimitInput field={field} key={field.key} onChange={onChange} value={value} />
          ))}
        </div>
      </details>
    </fieldset>
  )
}

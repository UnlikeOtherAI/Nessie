import type { Dispatch, SetStateAction } from 'react'
import { fieldLabelClass, type TriggerFormState } from './trigger-config'

type IntervalTriggerFieldsProps = {
  form: TriggerFormState
  setForm: Dispatch<SetStateAction<TriggerFormState>>
}

export const IntervalTriggerFields = ({
  form,
  setForm,
}: IntervalTriggerFieldsProps) => (
  <section className="rounded-xl border border-[color:var(--sep)] bg-[var(--scrim-weak)] p-4">
    <div className="grid gap-4 md:grid-cols-2">
      <div className="grid gap-1.5">
        <label className={fieldLabelClass} htmlFor="trigger-interval-minutes">
          Every N minutes
        </label>
        <input
          className="admin-input"
          id="trigger-interval-minutes"
          min="1"
          onChange={(nextEvent) =>
            setForm((current) => ({
              ...current,
              intervalMinutes: nextEvent.target.value,
            }))
          }
          step="1"
          type="number"
          value={form.intervalMinutes}
        />
      </div>

      <div className="grid gap-1.5">
        <label className={fieldLabelClass} htmlFor="trigger-interval-start">
          First run
        </label>
        <input
          className="admin-input"
          id="trigger-interval-start"
          onChange={(nextEvent) =>
            setForm((current) => ({
              ...current,
              nextRunAt: nextEvent.target.value,
            }))
          }
          type="datetime-local"
          value={form.nextRunAt}
        />
      </div>

      <div className="grid gap-1.5">
        <label className={fieldLabelClass} htmlFor="trigger-interval-until">
          Stop after
        </label>
        <input
          className="admin-input"
          id="trigger-interval-until"
          onChange={(nextEvent) =>
            setForm((current) => ({
              ...current,
              until: nextEvent.target.value,
            }))
          }
          type="datetime-local"
          value={form.until}
        />
        <p className="text-xs text-[color:var(--tx3)]">
          Optional. Leave empty to run until you pause it. Past this time the
          trigger stops firing and shows as paused; extend it to resume.
        </p>
      </div>
    </div>
  </section>
)

import type { Dispatch, SetStateAction } from 'react'
import { fieldLabelClass, type TriggerFormState } from './trigger-config'

type EventTriggerFieldsProps = {
  form: TriggerFormState
  setForm: Dispatch<SetStateAction<TriggerFormState>>
}

export const EventTriggerFields = ({
  form,
  setForm,
}: EventTriggerFieldsProps) => (
  <section className="rounded-xl border border-[color:var(--sep)] bg-[var(--scrim-weak)] p-4">
    <div className="grid gap-4">
      <div className="grid gap-1.5">
        <label className={fieldLabelClass} htmlFor="trigger-event-names">
          Event names
        </label>
        <textarea
          className="admin-input admin-input-compact admin-input-mono min-h-24"
          id="trigger-event-names"
          onChange={(nextEvent) =>
            setForm((current) => ({
              ...current,
              eventNames: nextEvent.target.value,
            }))
          }
          placeholder={'task.state_changed\nworkflow.completed'}
          value={form.eventNames}
        />
      </div>

      <div className="grid gap-1.5">
        <label className={fieldLabelClass} htmlFor="trigger-event-filter">
          Event filter JSON
        </label>
        <textarea
          className="admin-input admin-input-compact admin-input-mono min-h-28"
          id="trigger-event-filter"
          onChange={(nextEvent) =>
            setForm((current) => ({
              ...current,
              eventFilter: nextEvent.target.value,
            }))
          }
          placeholder={'{\n  "status": "failed"\n}'}
          value={form.eventFilter}
        />
      </div>
    </div>
  </section>
)

import type { Dispatch, SetStateAction } from 'react'
import {
  fieldLabelClass,
  type ScheduleMode,
  type TriggerFormState,
} from './trigger-config'

type ScheduledTriggerFieldsProps = {
  form: TriggerFormState
  isEditMode: boolean
  setForm: Dispatch<SetStateAction<TriggerFormState>>
}

export const ScheduledTriggerFields = ({
  form,
  isEditMode,
  setForm,
}: ScheduledTriggerFieldsProps) => (
  <section className="rounded-xl border border-[color:var(--sep)] bg-black/10 p-4">
    <div className="grid gap-4 md:grid-cols-2">
      <div className="grid gap-1.5">
        <label className={fieldLabelClass} htmlFor="trigger-schedule-mode">
          Schedule mode
        </label>
        <select
          className="admin-input"
          disabled={isEditMode}
          id="trigger-schedule-mode"
          onChange={(nextEvent) =>
            setForm((current) => ({
              ...current,
              scheduleMode: nextEvent.target.value as ScheduleMode,
            }))
          }
          value={form.scheduleMode}
        >
          <option value="once">One-off</option>
          <option value="cron">Cron</option>
        </select>
      </div>

      {form.scheduleMode === 'once' ? (
        <div className="grid gap-1.5">
          <label className={fieldLabelClass} htmlFor="trigger-next-run">
            Run at
          </label>
          <input
            className="admin-input"
            id="trigger-next-run"
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
      ) : (
        <>
          <div className="grid gap-1.5">
            <label className={fieldLabelClass} htmlFor="trigger-cron">
              Cron expression
            </label>
            <input
              className="admin-input"
              id="trigger-cron"
              onChange={(nextEvent) =>
                setForm((current) => ({
                  ...current,
                  cron: nextEvent.target.value,
                }))
              }
              placeholder="0 9 * * 1-5"
              value={form.cron}
            />
          </div>

          <div className="grid gap-1.5">
            <label className={fieldLabelClass} htmlFor="trigger-timezone">
              Timezone
            </label>
            <input
              className="admin-input"
              id="trigger-timezone"
              onChange={(nextEvent) =>
                setForm((current) => ({
                  ...current,
                  timezone: nextEvent.target.value,
                }))
              }
              placeholder="Europe/London"
              value={form.timezone}
            />
          </div>
        </>
      )}
    </div>
  </section>
)

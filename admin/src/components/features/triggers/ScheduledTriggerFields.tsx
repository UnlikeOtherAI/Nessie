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

const CRON_PRESETS: Array<{ cron: string; label: string }> = [
  { label: 'Hourly', cron: '0 * * * *' },
  { label: 'Daily 9:00', cron: '0 9 * * *' },
  { label: 'Weekdays 9:00', cron: '0 9 * * 1-5' },
  { label: 'Weekly Mon 9:00', cron: '0 9 * * 1' },
  { label: 'Monthly 1st 9:00', cron: '0 9 1 * *' },
]

export const ScheduledTriggerFields = ({
  form,
  isEditMode,
  setForm,
}: ScheduledTriggerFieldsProps) => (
  <section className="rounded-xl border border-[color:var(--sep)] bg-[var(--scrim-weak)] p-4">
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
            <div className="flex flex-wrap gap-1.5">
              {CRON_PRESETS.map((preset) => (
                <button
                  className={[
                    'rounded-full border px-2.5 py-1 text-[11px] transition',
                    form.cron === preset.cron
                      ? 'border-[color:var(--accent)] bg-[var(--accent-soft)] text-[var(--tx)]'
                      : 'border-[color:var(--sep)] text-[color:var(--tx2)] hover:bg-[var(--overlay-weak)]',
                  ].join(' ')}
                  key={preset.cron}
                  onClick={() =>
                    setForm((current) => ({ ...current, cron: preset.cron }))
                  }
                  type="button"
                >
                  {preset.label}
                </button>
              ))}
            </div>
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

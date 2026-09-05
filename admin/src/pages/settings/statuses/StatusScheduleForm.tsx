import { useState, type FormEvent } from 'react'
import type { UserStatusRecord, UserStatusScheduleKind } from '../../../lib/api-client'
import type { useCreateStatusSchedule, useDeleteStatusSchedule } from '../../../facades/statuses/hooks'
import { toFormErrors } from '../../../facades/form-errors'
import { Card } from '../../../components/shared/Card'
import { EmptyState } from '../../../components/shared/EmptyState'
import { FormActions, FormError } from '../../../components/shared/FormActions'
import { FormField } from '../../../components/shared/FormField'
import { Input, Select } from '../../../components/shared/FormControls'
import { Row, RowList } from '../../../components/shared/RowList'
import { SectionLabel } from '../../../components/primitives/SectionLabel'
import { dayLabels, describeSchedule, toIsoFromLocal } from './status-components'

type StatusScheduleFormProps = {
  createSchedule: ReturnType<typeof useCreateStatusSchedule>
  deleteSchedule: ReturnType<typeof useDeleteStatusSchedule>
  selectedStatus: UserStatusRecord
}

/**
 * The schedule form + list for the selected status: when it applies (weekly
 * or a date range) and the schedules already added. Split out of
 * `StatusesPage.tsx` (06-F6), which held this alongside two other unrelated
 * forms sharing nothing but the selected status.
 */
export const StatusScheduleForm = ({
  createSchedule,
  deleteSchedule,
  selectedStatus,
}: StatusScheduleFormProps) => {
  const [scheduleKind, setScheduleKind] = useState<UserStatusScheduleKind>('weekly')
  const [scheduleLabel, setScheduleLabel] = useState('')
  const [startsAt, setStartsAt] = useState('')
  const [endsAt, setEndsAt] = useState('')
  const [dayOfWeek, setDayOfWeek] = useState(1)
  const [startTime, setStartTime] = useState('12:00')
  const [endTime, setEndTime] = useState('13:00')
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone)
  const [scheduleError, setScheduleError] = useState<string | undefined>(undefined)

  const scheduleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setScheduleError(undefined)
    try {
      await createSchedule.mutateAsync(
        scheduleKind === 'date_range'
          ? {
              endsAt: toIsoFromLocal(endsAt),
              kind: scheduleKind,
              label: scheduleLabel.trim() || null,
              startsAt: toIsoFromLocal(startsAt),
              statusId: selectedStatus.id,
            }
          : {
              dayOfWeek,
              endTime,
              kind: scheduleKind,
              label: scheduleLabel.trim() || null,
              startTime,
              statusId: selectedStatus.id,
              timezone,
            },
      )
      setScheduleLabel('')
    } catch (error) {
      setScheduleError(toFormErrors(error).formError ?? 'Failed to add schedule.')
    }
  }

  return (
    <Card as="section">
      <SectionLabel>Schedules</SectionLabel>
      <form className="mt-4 grid gap-3" onSubmit={scheduleSubmit}>
        <div className="grid gap-2 md:grid-cols-3">
          <FormField label="Type">
            <Select
              onChange={(event) => setScheduleKind(event.target.value as UserStatusScheduleKind)}
              value={scheduleKind}
            >
              <option value="weekly">Weekly</option>
              <option value="date_range">Date range</option>
            </Select>
          </FormField>
          <FormField className="md:col-span-2" label="Label (optional)">
            <Input
              onChange={(event) => setScheduleLabel(event.target.value)}
              placeholder="Schedule label"
              value={scheduleLabel}
            />
          </FormField>
        </div>
        {scheduleKind === 'date_range' ? (
          <div className="grid gap-2 md:grid-cols-2">
            <FormField label="Starts">
              <Input
                onChange={(event) => setStartsAt(event.target.value)}
                required
                type="datetime-local"
                value={startsAt}
              />
            </FormField>
            <FormField label="Ends">
              <Input
                onChange={(event) => setEndsAt(event.target.value)}
                required
                type="datetime-local"
                value={endsAt}
              />
            </FormField>
          </div>
        ) : (
          <div className="grid gap-2 md:grid-cols-4">
            <FormField label="Day">
              <Select
                onChange={(event) => setDayOfWeek(Number(event.target.value))}
                value={dayOfWeek}
              >
                {dayLabels.map((day, index) => (
                  <option key={day} value={index}>
                    {day}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Start time">
              <Input
                onChange={(event) => setStartTime(event.target.value)}
                type="time"
                value={startTime}
              />
            </FormField>
            <FormField label="End time">
              <Input
                onChange={(event) => setEndTime(event.target.value)}
                type="time"
                value={endTime}
              />
            </FormField>
            <FormField label="Timezone">
              <Input
                onChange={(event) => setTimezone(event.target.value)}
                value={timezone}
              />
            </FormField>
          </div>
        )}
        <FormError>{scheduleError}</FormError>
        <FormActions>
          <button className="admin-button admin-button-secondary" type="submit">
            Add schedule
          </button>
        </FormActions>
      </form>
      <div className="mt-4">
        {selectedStatus.schedules.length > 0 ? (
          <RowList label="Schedules">
            {selectedStatus.schedules.map((schedule) => (
              <Row
                key={schedule.id}
                subtitle={describeSchedule(schedule)}
                title={schedule.label || (schedule.kind === 'weekly' ? 'Weekly' : 'Date range')}
                trailing={
                  <button
                    className="admin-button admin-button-secondary"
                    onClick={() =>
                      deleteSchedule.mutate({
                        scheduleId: schedule.id,
                        statusId: selectedStatus.id,
                      })}
                    type="button"
                  >
                    Remove
                  </button>
                }
              />
            ))}
          </RowList>
        ) : (
          <EmptyState>No schedules yet — this status only applies when set active.</EmptyState>
        )}
      </div>
    </Card>
  )
}

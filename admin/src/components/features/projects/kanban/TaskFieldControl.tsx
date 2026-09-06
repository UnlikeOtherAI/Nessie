import type { TaskFieldDefinitionRecord } from '../../../../facades/task-fields/hooks'
import { Input, Select } from '../../../shared/FormControls'
import { Pill } from '../../../primitives/Pill'

type TaskFieldControlProps = {
  definition: TaskFieldDefinitionRecord
  disabled?: boolean
  onChange: (value: unknown) => void
  people: { id: string; displayName: string }[]
  value: unknown
}

const asString = (value: unknown): string => (typeof value === 'string' ? value : '')
const asArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []

/**
 * One control per field type. The seven types exist precisely because each is
 * one arm here and one arm in the validator — adding an eighth is that pair of
 * changes, not a new abstraction.
 */
export const TaskFieldControl = ({
  definition,
  disabled,
  onChange,
  people,
  value,
}: TaskFieldControlProps) => {
  const live = definition.options.filter((option) => !option.retiredAt)

  switch (definition.type) {
    case 'number':
      return (
        <Input
          disabled={disabled}
          onChange={(event) =>
            onChange(event.target.value === '' ? null : Number(event.target.value))
          }
          size="compact"
          type="number"
          value={typeof value === 'number' ? String(value) : ''}
        />
      )
    case 'date':
      return (
        <Input
          disabled={disabled}
          onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
          size="compact"
          type="date"
          value={asString(value)}
        />
      )
    case 'url':
      return (
        <Input
          disabled={disabled}
          onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
          placeholder="https://"
          size="compact"
          type="url"
          value={asString(value)}
        />
      )
    case 'select':
      return (
        <Select
          disabled={disabled}
          onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
          size="compact"
          value={asString(value)}
        >
          <option value="">—</option>
          {live.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </Select>
      )
    case 'multi_select': {
      const selected = asArray(value)
      return (
        <div className="flex flex-wrap gap-1">
          {live.map((option) => {
            const on = selected.includes(option.id)
            return (
              <button
                aria-pressed={on}
                className="rounded-full"
                disabled={disabled}
                key={option.id}
                onClick={() =>
                  onChange(
                    on
                      ? selected.filter((entry) => entry !== option.id)
                      : [...selected, option.id],
                  )
                }
                type="button"
              >
                <Pill tone={on ? option.tone ?? 'accent' : 'outline'}>{option.label}</Pill>
              </button>
            )
          })}
          {live.length === 0 ? (
            <span className="text-xs text-[color:var(--tx3)]">No options yet.</span>
          ) : null}
        </div>
      )
    }
    case 'user':
      return (
        <Select
          disabled={disabled}
          onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
          size="compact"
          value={asString(value)}
        >
          <option value="">Unassigned</option>
          {people.map((person) => (
            <option key={person.id} value={person.id}>
              {person.displayName}
            </option>
          ))}
        </Select>
      )
    default:
      return (
        <Input
          disabled={disabled}
          maxLength={definition.config.maxLength}
          onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
          size="compact"
          value={asString(value)}
        />
      )
  }
}

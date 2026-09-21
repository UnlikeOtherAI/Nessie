import { faXmark } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { TaskFieldDefinitionRecord } from '../../../../facades/task-fields/hooks'
import { Input, Select } from '../../../shared/FormControls'
import { Pill } from '../../../primitives/Pill'
import { TokenInput } from '../../../shared/TokenInput'

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
      // The same growing pill field as Labels, without the create row: a
      // field's options are the project's vocabulary, managed in Settings.
      const selected = asArray(value)
      const tokens = selected.flatMap((id) => {
        const option = definition.options.find((entry) => entry.id === id)
        return option ? [{ id, label: option.label }] : []
      })
      return (
        <TokenInput
          ariaLabel={definition.name}
          disabled={disabled}
          onAdd={(id) => onChange(selected.includes(id) ? selected : [...selected, id])}
          onRemove={(id) => onChange(selected.filter((entry) => entry !== id))}
          options={live.map((option) => ({ id: option.id, label: option.label }))}
          placeholder={live.length === 0 ? 'No options yet.' : `Add ${definition.name.toLowerCase()}`}
          renderToken={(token, remove) => (
            <Pill
              className="gap-1"
              size="sm"
              tone={definition.options.find((option) => option.id === token.id)?.tone ?? 'muted'}
              uppercase={false}
            >
              {token.label}
              {remove ? (
                <button
                  aria-label={`Remove ${token.label}`}
                  className="admin-label-pill-remove"
                  onClick={(event) => {
                    event.stopPropagation()
                    remove()
                  }}
                  onMouseDown={(event) => event.preventDefault()}
                  tabIndex={-1}
                  type="button"
                >
                  <FontAwesomeIcon icon={faXmark} />
                </button>
              ) : null}
            </Pill>
          )}
          tokens={tokens}
        />
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

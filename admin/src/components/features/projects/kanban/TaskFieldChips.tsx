import { CARD_FIELD_CHIP_LIMIT } from '@nessie/schemas'
import type { TaskFieldDefinitionRecord } from '../../../../facades/task-fields/hooks'
import { Pill } from '../../../primitives/Pill'

type TaskFieldChipsProps = {
  definitions: TaskFieldDefinitionRecord[]
  people: Record<string, string>
  values: Record<string, unknown>
}

type Chip = { key: string; label: string; tone?: 'accent' | 'danger' | 'info' | 'muted' | 'outline' | 'success' | 'warning' }

const chipsFor = (
  definition: TaskFieldDefinitionRecord,
  value: unknown,
  people: Record<string, string>,
): Chip[] => {
  if (value === null || value === undefined || value === '') return []
  switch (definition.type) {
    case 'select': {
      const option = definition.options.find((entry) => entry.id === value)
      return option ? [{ key: option.id, label: option.label, tone: option.tone }] : []
    }
    case 'multi_select': {
      if (!Array.isArray(value)) return []
      return value.flatMap((entry) => {
        const option = definition.options.find((candidate) => candidate.id === entry)
        return option ? [{ key: option.id, label: option.label, tone: option.tone }] : []
      })
    }
    case 'user':
      // The name comes from the assignable-people list the board already holds,
      // never from a second copy of identity on the card.
      return typeof value === 'string' && people[value]
        ? [{ key: value, label: people[value] as string }]
        : []
    case 'number':
      return typeof value === 'number'
        ? [{ key: definition.id, label: `${definition.name} ${value}` }]
        : []
    default:
      return typeof value === 'string'
        ? [{ key: definition.id, label: value.slice(0, 40) }]
        : []
  }
}

/**
 * The custom fields a project marked `showOnCard`, as pills under the excerpt.
 * Capped: a card is a glance, and the eleventh label is not one.
 */
export const TaskFieldChips = ({ definitions, people, values }: TaskFieldChipsProps) => {
  const chips = definitions
    .filter((definition) => definition.showOnCard)
    .sort((a, b) => a.position - b.position)
    .flatMap((definition) => chipsFor(definition, values[definition.id], people))
  if (chips.length === 0) return null

  const shown = chips.slice(0, CARD_FIELD_CHIP_LIMIT)
  const overflow = chips.length - shown.length

  return (
    <div className="flex flex-wrap items-center gap-1">
      {shown.map((chip) => (
        <Pill key={chip.key} size="sm" tone={chip.tone ?? 'muted'} uppercase={false}>
          {chip.label}
        </Pill>
      ))}
      {overflow > 0 ? (
        <span className="text-[10px] text-[color:var(--tx3)]">+{overflow}</span>
      ) : null}
    </div>
  )
}

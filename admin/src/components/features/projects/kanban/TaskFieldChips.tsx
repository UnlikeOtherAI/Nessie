import { CARD_FIELD_CHIP_LIMIT, type TaskLabelSummary } from '@nessie/schemas'
import type { TaskFieldDefinitionRecord } from '../../../../facades/task-fields/hooks'
import { LabelPill } from '../../../primitives/LabelPill'
import { Pill } from '../../../primitives/Pill'

type TaskFieldChipsProps = {
  definitions: TaskFieldDefinitionRecord[]
  /** The ticket's labels; they come first and share the cap. */
  labels?: TaskLabelSummary[]
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
 * The ticket's labels, then the custom fields a project marked `showOnCard`,
 * as pills under the excerpt. One cap counts both: a card is a glance, and
 * the eleventh label is not one — whatever does not fit is a single `+N`.
 */
export const TaskFieldChips = ({ definitions, labels = [], people, values }: TaskFieldChipsProps) => {
  const chips = definitions
    .filter((definition) => definition.showOnCard)
    .sort((a, b) => a.position - b.position)
    .flatMap((definition) => chipsFor(definition, values[definition.id], people))
  const total = labels.length + chips.length
  if (total === 0) return null

  const shownLabels = labels.slice(0, CARD_FIELD_CHIP_LIMIT)
  const shownChips = chips.slice(0, CARD_FIELD_CHIP_LIMIT - shownLabels.length)
  const overflow = total - shownLabels.length - shownChips.length

  return (
    <div className="flex flex-wrap items-center gap-1" data-testid="card-chips">
      {shownLabels.map((label) => (
        <LabelPill color={label.color} key={label.id} name={label.name} size="sm" />
      ))}
      {shownChips.map((chip) => (
        <Pill key={chip.key} size="sm" tone={chip.tone ?? 'muted'} uppercase={false}>
          {chip.label}
        </Pill>
      ))}
      {overflow > 0 ? (
        <span className="text-[10px] text-[color:var(--tx3)]" title={`${overflow} more`}>+{overflow}</span>
      ) : null}
    </div>
  )
}

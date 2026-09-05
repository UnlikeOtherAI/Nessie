import { useState } from 'react'
import type {
  TaskFieldDefinitionRecord,
  TaskFieldOption,
  TaskFieldType,
} from '../../../facades/task-fields/hooks'
import {
  useCreateTaskField,
  useDeleteTaskField,
  useTaskFields,
  useUpdateTaskField,
} from '../../../facades/task-fields/hooks'
import { ConfirmDialog } from '../../../components/shared/ConfirmDialog'
import { EmptyState } from '../../../components/shared/EmptyState'
import { Input, Select } from '../../../components/shared/FormControls'
import { Section } from '../../../components/shared/PageBody'
import { Pill } from '../../../components/primitives/Pill'

const errorMessage = (cause: unknown, fallback: string): string =>
  cause instanceof Error ? cause.message : fallback

const TYPE_LABEL: Record<TaskFieldType, string> = {
  text: 'Text',
  number: 'Number',
  date: 'Date',
  url: 'Link',
  select: 'Choice',
  multi_select: 'Multiple choice',
  user: 'Person',
}

const TYPE_ORDER: TaskFieldType[] = [
  'text',
  'number',
  'date',
  'url',
  'select',
  'multi_select',
  'user',
]

const isOptionType = (type: TaskFieldType): boolean =>
  type === 'select' || type === 'multi_select'

const optionId = (label: string): string =>
  `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`

type FieldRowProps = {
  definition: TaskFieldDefinitionRecord
  onSaveError: (message: string) => void
  onSaved: () => void
  projectId: string
}

const FieldRow = ({ definition, onSaveError, onSaved, projectId }: FieldRowProps) => {
  const update = useUpdateTaskField(projectId)
  const remove = useDeleteTaskField(projectId)
  const [name, setName] = useState(definition.name)
  const [newOption, setNewOption] = useState('')
  const [deleteOpen, setDeleteOpen] = useState(false)

  const save = (input: Parameters<typeof update.mutate>[0], failure: string) =>
    update.mutate(input, {
      onError: (cause) => onSaveError(errorMessage(cause, failure)),
      onSuccess: onSaved,
    })

  const live = definition.options.filter((option) => !option.retiredAt)

  const addOption = () => {
    const label = newOption.trim()
    if (!label) return
    // Two live options with the same label render as two identical pills that
    // nothing can tell apart. Retired ones may share a label freely.
    if (live.some((option) => option.label.toLowerCase() === label.toLowerCase())) {
      onSaveError(`“${label}” is already an option of ${definition.name}.`)
      setNewOption('')
      return
    }
    const option: TaskFieldOption = { id: optionId(label), label }
    save(
      { id: definition.id, options: [...definition.options, option] },
      'Could not add the option',
    )
    setNewOption('')
  }

  // Retire rather than delete: a retired option leaves every picker but stays
  // readable on the tasks that already carry it.
  const retireOption = (id: string) =>
    save(
      {
        id: definition.id,
        options: definition.options.map((option) =>
          option.id === id ? { ...option, retiredAt: new Date().toISOString() } : option,
        ),
      },
      'Could not retire the option',
    )

  return (
    <>
      <div className="grid gap-2 border-b border-[color:var(--sep)] py-2 last:border-b-0">
        <div className="flex items-center gap-2">
          <Input
            aria-label="Field name"
            className="min-w-0 flex-1"
            onBlur={() => {
              const trimmed = name.trim()
              if (!trimmed || trimmed === definition.name) return
              save({ id: definition.id, name: trimmed }, 'Could not rename the field')
            }}
            onChange={(event) => setName(event.target.value)}
            size="compact"
            value={name}
          />
          {/* Type is immutable: changing it would have to rewrite or discard
              every value already stored under this definition. */}
          <span className="text-xs uppercase tracking-[0.16em] text-[color:var(--tx3)]">
            {TYPE_LABEL[definition.type]}
          </span>
          <label className="flex items-center gap-1.5 text-xs text-[color:var(--tx2)]">
            <input
              checked={definition.showOnCard}
              onChange={(event) =>
                save(
                  { id: definition.id, showOnCard: event.target.checked },
                  'Could not change where the field shows',
                )
              }
              type="checkbox"
            />
            Show on card
          </label>
          <button
            className="text-xs text-[color:var(--tx3)] hover:text-[color:var(--danger-text)]"
            onClick={() => setDeleteOpen(true)}
            type="button"
          >
            Delete
          </button>
        </div>

        {isOptionType(definition.type) ? (
          <div className="flex flex-wrap items-center gap-1.5 pl-1">
            {live.map((option) => (
              <button
                className="rounded-full"
                key={option.id}
                onClick={() => retireOption(option.id)}
                title={`Retire “${option.label}”`}
                type="button"
              >
                <Pill size="sm" tone={option.tone ?? 'muted'} uppercase={false}>
                  {option.label} ×
                </Pill>
              </button>
            ))}
            <Input
              aria-label={`New option for ${definition.name}`}
              className="max-w-[180px]"
              onChange={(event) => setNewOption(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') addOption()
              }}
              placeholder="Add an option…"
              size="compact"
              value={newOption}
            />
          </div>
        ) : null}
      </div>

      <ConfirmDialog
        body="Every task in this project loses the value it held for this field."
        confirmLabel="Delete field"
        destructive
        onCancel={() => setDeleteOpen(false)}
        onConfirm={() => {
          setDeleteOpen(false)
          remove.mutate(definition.id, {
            onError: (cause) => onSaveError(errorMessage(cause, 'Could not delete the field')),
            onSuccess: onSaved,
          })
        }}
        open={deleteOpen}
        title={`Delete field “${definition.name}”?`}
      />
    </>
  )
}

type FieldsSettingsSectionProps = {
  canAdminister: boolean
  onSaveError: (message: string) => void
  onSaved: () => void
  projectId: string
}

/**
 * The project's custom task fields. Anything a task needs to carry beyond
 * title, priority and deadline — and where an external source's fields land.
 */
export const FieldsSettingsSection = ({
  canAdminister,
  onSaveError,
  onSaved,
  projectId,
}: FieldsSettingsSectionProps) => {
  const { data: definitions = [] } = useTaskFields(projectId)
  const create = useCreateTaskField(projectId)
  const [newName, setNewName] = useState('')
  const [newType, setNewType] = useState<TaskFieldType>('text')

  const add = () => {
    const name = newName.trim()
    if (!name) return
    create.mutate(
      { name, type: newType },
      {
        onError: (cause) => onSaveError(errorMessage(cause, 'Could not add the field')),
        onSuccess: () => {
          setNewName('')
          onSaved()
        },
      },
    )
  }

  const ordered = [...definitions].sort((a, b) => a.position - b.position)

  return (
    <Section
      description="Fields belong to the project, so a task carries the same ones on every board.
        A field's type cannot change once it exists — add a new field instead."
      title="Custom fields"
    >
      {ordered.length === 0 ? (
        <EmptyState title="No custom fields.">
          Add one to track anything a task needs beyond title, priority and deadline.
        </EmptyState>
      ) : (
        <div className="grid">
          {ordered.map((definition) => (
            <FieldRow
              definition={definition}
              key={definition.id}
              onSaveError={onSaveError}
              onSaved={onSaved}
              projectId={projectId}
            />
          ))}
        </div>
      )}

      {canAdminister ? (
        <div className="flex items-center gap-2 border-t border-[color:var(--sep)] pt-3">
          <Input
            aria-label="New field name"
            className="min-w-0 flex-1"
            onChange={(event) => setNewName(event.target.value)}
            placeholder="New field name…"
            size="compact"
            value={newName}
          />
          <Select
            aria-label="New field type"
            className="max-w-[180px]"
            onChange={(event) => setNewType(event.target.value as TaskFieldType)}
            size="compact"
            value={newType}
          >
            {TYPE_ORDER.map((type) => (
              <option key={type} value={type}>
                {TYPE_LABEL[type]}
              </option>
            ))}
          </Select>
          <button
            className="admin-button admin-button-primary admin-button-compact"
            disabled={!newName.trim() || create.isPending}
            onClick={add}
            type="button"
          >
            Add field
          </button>
        </div>
      ) : null}
    </Section>
  )
}

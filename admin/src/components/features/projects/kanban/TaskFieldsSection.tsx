import type { TaskFieldDefinitionRecord } from '../../../../facades/task-fields/hooks'
import { FormField } from '../../../shared/FormField'
import { TaskFieldControl } from './TaskFieldControl'

type TaskFieldsSectionProps = {
  definitions: TaskFieldDefinitionRecord[]
  disabled?: boolean
  manageHref?: string
  onChange: (fieldId: string, value: unknown) => void
  people: { id: string; displayName: string }[]
  values: Record<string, unknown>
}

/**
 * A project's custom fields on one task, under Deadline in the dialog's right
 * column. Nothing renders when the project defines none — an empty "Fields"
 * heading names no decision.
 */
export const TaskFieldsSection = ({
  definitions,
  disabled,
  manageHref,
  onChange,
  people,
  values,
}: TaskFieldsSectionProps) => {
  if (definitions.length === 0) return null
  const ordered = [...definitions].sort((a, b) => a.position - b.position)

  return (
    <>
      {ordered.map((definition) => (
        <FormField key={definition.id} label={definition.name}>
          <TaskFieldControl
            definition={definition}
            disabled={disabled}
            onChange={(value) => onChange(definition.id, value)}
            people={people}
            value={values[definition.id]}
          />
        </FormField>
      ))}
      {manageHref ? (
        <a
          className="text-xs text-[color:var(--tx3)] hover:text-[color:var(--tx)]"
          href={manageHref}
        >
          Manage fields…
        </a>
      ) : null}
    </>
  )
}

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import type { TaskLabelSummary } from '@nessie/schemas'
import { FieldLabel } from '../../../primitives/FieldLabel'
import { LabelPill } from '../../../primitives/LabelPill'
import { Notice } from '../../../primitives/Notice'
import { TokenInput } from '../../../shared/TokenInput'
import { formErrorMessage } from '../../../../facades/forms/form-errors'
import {
  nextLabelColor,
  useBoardLabels,
  useCreateBoardLabel,
} from '../../../../facades/task-labels/hooks'

type TaskLabelsFieldProps = {
  /**
   * The ticket's home board — the board whose labels the field lists and
   * creates on (a label belongs to a board). Null until the project's boards
   * have loaded; the field waits, disabled, rather than guess.
   */
  boardId: string | null
  disabled?: boolean
  onChange: (labelIds: string[]) => void
  /**
   * Called as *Manage labels…* is followed. The board's settings are pushed
   * over the board, which stays mounted beneath them, and the ticket dialog is
   * portalled out of that retained layer — so the host closes it here or it
   * stays open over the page it just opened.
   */
  onLeave?: () => void
  projectId: string
  /**
   * The provider's name when the ticket mirrors a source read-only: its own
   * labels are then locked here, because the source would put them back.
   */
  readOnlySourceName?: string | null
  /** The task's labels as the server last sent them — names for ids the list has not loaded. */
  taskLabels?: TaskLabelSummary[]
  value: string[]
}

/**
 * The ticket's labels as pills inside one growing field (ui.md §5.7).
 *
 * Every label of the ticket's board is one focus away in the list, and a name
 * that does not exist yet is one Enter away from existing on that board: the
 * *Create label "x"* row adopts an existing label on a name clash instead of
 * failing, because the person meant "this label" either way. Management —
 * rename, recolour, delete — lives in Board → Settings → Labels, which the
 * list's footer links to.
 */
export const TaskLabelsField = ({
  boardId,
  disabled = false,
  onChange,
  onLeave,
  projectId,
  readOnlySourceName,
  taskLabels = [],
  value,
}: TaskLabelsFieldProps) => {
  const { t } = useTranslation('projects')
  const labelsQuery = useBoardLabels(projectId, boardId)
  const createLabel = useCreateBoardLabel(projectId, boardId ?? '')
  const labels = useMemo(() => labelsQuery.data ?? [], [labelsQuery.data])

  const byId = useMemo(() => {
    const map = new Map<string, TaskLabelSummary>()
    for (const label of taskLabels) map.set(label.id, label)
    for (const label of labels) map.set(label.id, label)
    return map
  }, [labels, taskLabels])

  const lockedTitle = readOnlySourceName ? t('taskLabels.ownedBy', { provider: readOnlySourceName }) : undefined
  const locked = (label: TaskLabelSummary | undefined) => Boolean(readOnlySourceName && label?.external)

  const tokens = value.flatMap((id) => {
    const label = byId.get(id)
    return label ? [{ id, label: label.name, removable: !locked(label) }] : []
  })
  const options = labels.map((label) => ({
    disabled: locked(label) || undefined,
    id: label.id,
    label: label.name,
    title: locked(label) ? lockedTitle : undefined,
  }))

  // No board yet reads as loading: the list it would show is not known.
  const loading = !boardId || labelsQuery.isLoading
  const inputId = `task-labels-${projectId}`

  return (
    <div className="grid gap-1.5">
      <FieldLabel htmlFor={inputId}>{t('taskLabels.title')}</FieldLabel>
      <TokenInput
        ariaLabel={t('taskLabels.title')}
        createLabel={(text) => t('taskLabels.create', { name: text })}
        disabled={disabled || loading}
        footer={boardId
          ? <Link onClick={onLeave} to={`/projects/${projectId}/boards/${boardId}/settings?tab=labels`}>{t('taskLabels.manage')}</Link>
          : undefined}
        id={inputId}
        onAdd={(id) => onChange(value.includes(id) ? value : [...value, id])}
        onCreate={async (text) => {
          // The field shows a rejection under its list; this makes it a sentence.
          try {
            const created = await createLabel.mutateAsync({
              adoptExisting: true,
              color: nextLabelColor(labels.length),
              name: text.trim(),
            })
            return { id: created.id }
          } catch (cause) {
            throw new Error(formErrorMessage(cause, t('taskLabels.createError')))
          }
        }}
        onRemove={(id) => onChange(value.filter((entry) => entry !== id))}
        options={options}
        placeholder={loading ? t('taskLabels.loading') : t('taskLabels.add')}
        renderOption={(option) => {
          const label = byId.get(option.id)
          return label
            ? <LabelPill color={label.color} external={label.external} name={label.name} size="sm" />
            : option.label
        }}
        renderToken={(token, remove) => {
          const label = byId.get(token.id)
          return (
            <LabelPill
              color={label?.color ?? ''}
              external={label?.external}
              name={token.label}
              onRemove={remove}
              size="sm"
              title={locked(label) ? lockedTitle : undefined}
            />
          )
        }}
        tokens={tokens}
      />
      {labelsQuery.isError ? (
        <Notice size="sm" tone="danger">
          {t('taskLabels.loadError')}{' '}
          <button className="underline" onClick={() => void labelsQuery.refetch()} type="button">
            {t('taskLabels.retry')}
          </button>
        </Notice>
      ) : null}
    </div>
  )
}

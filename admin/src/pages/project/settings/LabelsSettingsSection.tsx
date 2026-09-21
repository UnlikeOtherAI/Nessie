import { useState } from 'react'
import { faPen, faTrash } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { TaskLabelRecord } from '@nessie/schemas'
import { LabelPill } from '../../../components/primitives/LabelPill'
import { ConfirmDialog } from '../../../components/shared/ConfirmDialog'
import { Input } from '../../../components/shared/FormControls'
import { LabelColorPicker } from '../../../components/shared/LabelColorPicker'
import { Section } from '../../../components/shared/PageBody'
import { QueryState } from '../../../components/shared/QueryState'
import { PROVIDER_LABEL } from '../../../facades/board-sources/hooks'
import { formErrorMessage } from '../../../facades/forms/form-errors'
import {
  nextLabelColor,
  takenLabelFromError,
  useCreateProjectLabel,
  useDeleteProjectLabel,
  useProjectLabels,
  useUpdateProjectLabel,
} from '../../../facades/task-labels/hooks'

type LabelsSettingsSectionProps = {
  canAdminister: boolean
  onSaveError: (message: string) => void
  onSaved: () => void
  projectId: string
}

const iconButtonClass = [
  'flex h-8 w-8 flex-none items-center justify-center rounded text-[color:var(--tx3)]',
  'hover:bg-[color:var(--overlay)] hover:text-[color:var(--tx)] disabled:opacity-50',
].join(' ')

const ticketCount = (count: number | undefined): string | null =>
  count && count > 0 ? `${count} ${count === 1 ? 'ticket' : 'tickets'}` : null

type LabelRowProps = {
  canAdminister: boolean
  label: TaskLabelRecord
  onSaveError: (message: string) => void
  onSaved: () => void
  projectId: string
}

const LabelRow = ({ canAdminister, label, onSaveError, onSaved, projectId }: LabelRowProps) => {
  const update = useUpdateProjectLabel(projectId)
  const remove = useDeleteProjectLabel(projectId)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(label.name)
  const [nameError, setNameError] = useState<string | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const provider = label.source ? PROVIDER_LABEL[label.source.provider] : null
  // A source-owned label's name is the source's; its colour is Nessie's own.
  const nameLocked = !canAdminister || Boolean(label.source)

  const saveName = () => {
    const trimmed = name.trim()
    if (!trimmed || trimmed === label.name) {
      setRenaming(false)
      setName(label.name)
      return
    }
    setNameError(null)
    update.mutate(
      { id: label.id, name: trimmed },
      {
        onError: (cause) =>
          setNameError(takenLabelFromError(cause)
            ? 'A label with this name exists.'
            : formErrorMessage(cause, 'Could not rename the label')),
        onSuccess: () => {
          setRenaming(false)
          onSaved()
        },
      },
    )
  }

  return (
    <li className="grid gap-1 py-2" data-label-id={label.id}>
      <div className="flex flex-wrap items-center gap-2">
        {renaming ? (
          <Input
            aria-label={`Name of ${label.name}`}
            autoFocus
            className="min-w-0 max-w-xs flex-1"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                saveName()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                setName(label.name)
                setNameError(null)
                setRenaming(false)
              }
            }}
            size="compact"
            value={name}
          />
        ) : (
          <button
            className="min-w-0 rounded-full disabled:cursor-default"
            disabled={nameLocked}
            onClick={() => setRenaming(true)}
            title={label.source ? `${provider} owns the name; colour is yours` : `Rename ${label.name}`}
            type="button"
          >
            <LabelPill color={label.color} external={Boolean(label.source)} name={label.name} />
          </button>
        )}
        {!nameLocked && !renaming ? (
          <button
            aria-label={`Rename ${label.name}`}
            className={iconButtonClass}
            onClick={() => setRenaming(true)}
            type="button"
          >
            <FontAwesomeIcon icon={faPen} />
          </button>
        ) : null}
        {provider ? <span className="text-xs text-[color:var(--tx3)]">{provider}</span> : null}
        <span className="ml-auto flex items-center gap-2">
          {ticketCount(label.taskCount) ? (
            <span className="text-xs text-[color:var(--tx3)]">{ticketCount(label.taskCount)}</span>
          ) : null}
          <LabelColorPicker
            disabled={!canAdminister}
            label={`Colour of ${label.name}`}
            onChange={(color) =>
              update.mutate(
                { color, id: label.id },
                {
                  onError: (cause) => onSaveError(formErrorMessage(cause, 'Could not recolour the label')),
                  onSuccess: onSaved,
                },
              )
            }
            value={label.color}
          />
          {canAdminister ? (
            <button
              aria-label={`Delete ${label.name}`}
              className={iconButtonClass}
              onClick={() => setDeleteOpen(true)}
              type="button"
            >
              <FontAwesomeIcon icon={faTrash} />
            </button>
          ) : null}
        </span>
      </div>
      {label.source && canAdminister ? (
        <p className="text-xs text-[color:var(--tx3)]">{provider} owns the name; colour is yours.</p>
      ) : null}
      {nameError ? <p className="text-xs text-[color:var(--danger-text)]" role="alert">{nameError}</p> : null}

      <ConfirmDialog
        body={ticketCount(label.taskCount)
          ? `It comes off ${ticketCount(label.taskCount)}.`
          : 'No ticket carries it.'}
        confirmLabel="Delete label"
        destructive
        onCancel={() => setDeleteOpen(false)}
        onConfirm={() => {
          setDeleteOpen(false)
          remove.mutate(label.id, {
            onError: (cause) => onSaveError(formErrorMessage(cause, 'Could not delete the label')),
            onSuccess: onSaved,
          })
        }}
        open={deleteOpen}
        title={`Delete “${label.name}”?`}
      />
    </li>
  )
}

/**
 * The project's labels (ui.md §5.10): rename, recolour, delete. Tickets pick
 * them up — and create new ones — from the token field in the ticket dialog;
 * this is where the vocabulary is tidied.
 */
export const LabelsSettingsSection = ({
  canAdminister,
  onSaveError,
  onSaved,
  projectId,
}: LabelsSettingsSectionProps) => {
  const labelsQuery = useProjectLabels(projectId)
  const create = useCreateProjectLabel(projectId)
  const labels = [...(labelsQuery.data ?? [])].sort((a, b) => a.name.localeCompare(b.name))
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState<string>(nextLabelColor(0))
  const [newError, setNewError] = useState<string | null>(null)

  const startAdding = () => {
    setNewName('')
    setNewColor(nextLabelColor(labels.length))
    setNewError(null)
    setAdding(true)
  }

  const add = () => {
    const name = newName.trim()
    if (!name || create.isPending) return
    setNewError(null)
    create.mutate(
      { color: newColor, name },
      {
        onError: (cause) =>
          setNewError(takenLabelFromError(cause)
            ? 'A label with this name exists.'
            : formErrorMessage(cause, 'Could not add the label')),
        onSuccess: () => {
          setAdding(false)
          setNewName('')
          onSaved()
        },
      },
    )
  }

  return (
    <Section
      actions={canAdminister && !adding ? (
        <button
          className="admin-button admin-button-primary admin-button-compact"
          onClick={startAdding}
          type="button"
        >
          New label
        </button>
      ) : null}
      description="Labels belong to the project, so a ticket carries the same ones on every board.
        Renaming or recolouring one changes it on every ticket that has it."
      title="Labels"
    >
      {!canAdminister ? (
        <p className="text-sm text-[color:var(--tx3)]">Only project members can change labels.</p>
      ) : null}

      {adding ? (
        <div className="grid gap-1" data-testid="new-label-form">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label="New label name"
              autoFocus
              className="min-w-0 max-w-xs flex-1"
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  add()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  setAdding(false)
                }
              }}
              placeholder="Label name…"
              size="compact"
              value={newName}
            />
            <LabelColorPicker label="New label colour" onChange={setNewColor} value={newColor} />
            <button
              className="admin-button admin-button-primary admin-button-compact"
              disabled={!newName.trim() || create.isPending}
              onClick={add}
              type="button"
            >
              Add
            </button>
            <button
              className="admin-button admin-button-secondary admin-button-compact"
              onClick={() => setAdding(false)}
              type="button"
            >
              Cancel
            </button>
          </div>
          {newError ? <p className="text-xs text-[color:var(--danger-text)]" role="alert">{newError}</p> : null}
        </div>
      ) : null}

      <QueryState
        emptyLabel="No labels yet. Add one here, or type a new one on any ticket."
        errorLabel="Couldn't load labels."
        isEmpty={labels.length === 0}
        loadingLabel="Loading labels…"
        query={labelsQuery}
      >
        {() => (
          <ul aria-label="Labels" className="grid divide-y divide-[color:var(--sep)]">
            {labels.map((label) => (
              <LabelRow
                canAdminister={canAdminister}
                key={label.id}
                label={label}
                onSaveError={onSaveError}
                onSaved={onSaved}
                projectId={projectId}
              />
            ))}
          </ul>
        )}
      </QueryState>
    </Section>
  )
}

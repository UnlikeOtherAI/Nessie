import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
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
  useBoardLabels,
  useCreateBoardLabel,
  useDeleteBoardLabel,
  useUpdateBoardLabel,
} from '../../../facades/task-labels/hooks'

type LabelsSettingsSectionProps = {
  /** The board whose labels these are — a label belongs to one board. */
  boardId: string
  canAdminister: boolean
  onSaveError: (message: string) => void
  onSaved: () => void
  projectId: string
}

const iconButtonClass = [
  'flex h-8 w-8 flex-none items-center justify-center rounded text-[color:var(--tx3)]',
  'hover:bg-[color:var(--overlay)] hover:text-[color:var(--tx)] disabled:opacity-50',
].join(' ')

const ticketCount = (count: number | undefined, t: TFunction<'projects'>): string | null =>
  count && count > 0 ? t('labelSettings.ticketCount', { count }) : null

type LabelRowProps = {
  boardId: string
  canAdminister: boolean
  label: TaskLabelRecord
  onSaveError: (message: string) => void
  onSaved: () => void
  projectId: string
}

const LabelRow = ({ boardId, canAdminister, label, onSaveError, onSaved, projectId }: LabelRowProps) => {
  const { t } = useTranslation('projects')
  const update = useUpdateBoardLabel(projectId, boardId)
  const remove = useDeleteBoardLabel(projectId, boardId)
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
            ? t('labelSettings.duplicateName')
            : formErrorMessage(cause, t('labelSettings.renameError'))),
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
            aria-label={t('labelSettings.nameOf', { name: label.name })}
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
            title={label.source ? t('labelSettings.providerOwnsName', { provider }) : t('labelSettings.rename', { name: label.name })}
            type="button"
          >
            <LabelPill color={label.color} external={Boolean(label.source)} name={label.name} />
          </button>
        )}
        {!nameLocked && !renaming ? (
          <button
            aria-label={t('labelSettings.rename', { name: label.name })}
            className={iconButtonClass}
            onClick={() => setRenaming(true)}
            type="button"
          >
            <FontAwesomeIcon icon={faPen} />
          </button>
        ) : null}
        {provider ? <span className="text-xs text-[color:var(--tx3)]">{provider}</span> : null}
        <span className="ml-auto flex items-center gap-2">
          {ticketCount(label.taskCount, t) ? (
            <span className="text-xs text-[color:var(--tx3)]">{ticketCount(label.taskCount, t)}</span>
          ) : null}
          <LabelColorPicker
            disabled={!canAdminister}
            label={t('labelSettings.colourOf', { name: label.name })}
            onChange={(color) =>
              update.mutate(
                { color, id: label.id },
                {
                  onError: (cause) => onSaveError(formErrorMessage(cause, t('labelSettings.recolourError'))),
                  onSuccess: onSaved,
                },
              )
            }
            value={label.color}
          />
          {canAdminister ? (
            <button
              aria-label={t('labelSettings.delete', { name: label.name })}
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
        <p className="text-xs text-[color:var(--tx3)]">{t('labelSettings.providerOwnsName', { provider })}</p>
      ) : null}
      {nameError ? <p className="text-xs text-[color:var(--danger-text)]" role="alert">{nameError}</p> : null}

      <ConfirmDialog
        body={ticketCount(label.taskCount, t)
          ? t('labelSettings.deleteBody', { count: label.taskCount })
          : t('labelSettings.noTicketCarries')}
        confirmLabel={t('labelSettings.deleteLabel')}
        destructive
        onCancel={() => setDeleteOpen(false)}
        onConfirm={() => {
          setDeleteOpen(false)
          remove.mutate(label.id, {
            onError: (cause) => onSaveError(formErrorMessage(cause, t('labelSettings.deleteError'))),
            onSuccess: onSaved,
          })
        }}
        open={deleteOpen}
        title={t('labelSettings.deleteTitle', { name: label.name })}
      />
    </li>
  )
}

/**
 * A board's labels (ui.md §5.10, board-labels-and-attachment-removal.md §8.9):
 * rename, recolour, delete. Tickets on the board pick them up — and create new
 * ones — from the token field in the ticket dialog; this is where the board's
 * vocabulary is tidied. It is Board → Settings → Labels.
 */
export const LabelsSettingsSection = ({
  boardId,
  canAdminister,
  onSaveError,
  onSaved,
  projectId,
}: LabelsSettingsSectionProps) => {
  const { t } = useTranslation('projects')
  const labelsQuery = useBoardLabels(projectId, boardId)
  const create = useCreateBoardLabel(projectId, boardId)
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
            ? t('labelSettings.duplicateName')
            : formErrorMessage(cause, t('labelSettings.addError'))),
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
          {t('labelSettings.newLabel')}
        </button>
      ) : null}
      description={t('labelSettings.description')}
      title={t('taskLabels.title')}
    >
      {!canAdminister ? (
        <p className="text-sm text-[color:var(--tx3)]">{t('labelSettings.permission')}</p>
      ) : null}

      {adding ? (
        <div className="grid gap-1" data-testid="new-label-form">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label={t('labelSettings.newLabelName')}
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
              placeholder={t('labelSettings.labelNamePlaceholder')}
              size="compact"
              value={newName}
            />
            <LabelColorPicker label={t('labelSettings.newLabelColour')} onChange={setNewColor} value={newColor} />
            <button
              className="admin-button admin-button-primary admin-button-compact"
              disabled={!newName.trim() || create.isPending}
              onClick={add}
              type="button"
            >
              {t('common.add')}
            </button>
            <button
              className="admin-button admin-button-secondary admin-button-compact"
              onClick={() => setAdding(false)}
              type="button"
            >
              {t('common.cancel')}
            </button>
          </div>
          {newError ? <p className="text-xs text-[color:var(--danger-text)]" role="alert">{newError}</p> : null}
        </div>
      ) : null}

      <QueryState
        emptyLabel={t('labelSettings.empty')}
        errorLabel={t('labelSettings.loadError')}
        isEmpty={labels.length === 0}
        loadingLabel={t('taskLabels.loading')}
        query={labelsQuery}
      >
        {() => (
          <ul aria-label={t('taskLabels.title')} className="grid divide-y divide-[color:var(--sep)]">
            {labels.map((label) => (
              <LabelRow
                boardId={boardId}
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

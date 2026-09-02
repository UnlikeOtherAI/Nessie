import { useEffect, useState } from 'react'
import {
  type BoardColumn,
  type ColumnCategory,
  useCreateColumn,
  useDeleteColumn,
  useProjectBoard,
  useSetBoardStyle,
  useUpdateColumn,
} from '../../facades/board/hooks'
import { ChoiceGroup } from '../../components/shared/ChoiceGroup'
import { ConfirmDialog } from '../../components/shared/ConfirmDialog'
import { Input, Select } from '../../components/shared/FormControls'
import { FormError, FormSuccess } from '../../components/shared/FormActions'
import { PageBody, Section } from '../../components/shared/PageBody'
import { QueryState } from '../../components/shared/QueryState'
import { CATEGORY_LABEL, CATEGORY_ORDER } from '../../components/kanban/kanban-config'
import { useIsOwner } from '../../components/shared/OwnerGate'

const errorMessage = (cause: unknown, fallback: string): string =>
  cause instanceof Error ? cause.message : fallback

const CategorySelect = ({
  value,
  disabled,
  onChange,
  ariaLabel,
}: {
  value: ColumnCategory
  disabled?: boolean
  onChange: (category: ColumnCategory) => void
  ariaLabel: string
}) => (
  <Select
    aria-label={ariaLabel}
    className="max-w-[160px]"
    disabled={disabled}
    onChange={(event) => onChange(event.target.value as ColumnCategory)}
    size="compact"
    value={value}
  >
    {CATEGORY_ORDER.map((category) => (
      <option key={category} value={category}>
        {CATEGORY_LABEL[category]}
      </option>
    ))}
  </Select>
)

type ColumnRowProps = {
  column: BoardColumn
  projectId: string
  isFirst: boolean
  isLast: boolean
  prevId?: string
  nextId?: string
  prevPosition?: number
  nextPosition?: number
  onSaved: () => void
  onSaveError: (message: string) => void
}

const ColumnRow = ({
  column,
  projectId,
  isFirst,
  isLast,
  prevId,
  nextId,
  prevPosition,
  nextPosition,
  onSaved,
  onSaveError,
}: ColumnRowProps) => {
  const update = useUpdateColumn(projectId)
  const remove = useDeleteColumn(projectId)
  const [name, setName] = useState(column.name)
  const [deleteOpen, setDeleteOpen] = useState(false)

  const commitName = () => {
    const trimmed = name.trim()
    if (!trimmed || trimmed === column.name) return
    update.mutate(
      { id: column.id, name: trimmed },
      {
        onError: (cause) => onSaveError(errorMessage(cause, 'Could not rename column')),
        onSuccess: onSaved,
      },
    )
  }

  const commitCategory = (category: ColumnCategory) => {
    update.mutate(
      { id: column.id, category },
      {
        onError: (cause) => onSaveError(errorMessage(cause, 'Could not change column category')),
        onSuccess: onSaved,
      },
    )
  }

  // Reorder by swapping this column's position with its neighbour's.
  const swapWith = (otherId?: string, otherPosition?: number) => {
    if (otherId === undefined || otherPosition === undefined) return
    update.mutate({ id: column.id, position: otherPosition })
    update.mutate({ id: otherId, position: column.position })
  }

  return (
    <>
      <div className="flex items-center gap-2">
        <div className="flex flex-col">
          <button
            aria-label="Move up"
            className="text-[10px] text-[color:var(--tx3)] hover:text-[color:var(--tx)] disabled:opacity-30"
            disabled={isFirst}
            onClick={() => swapWith(prevId, prevPosition)}
            type="button"
          >
            ▲
          </button>
          <button
            aria-label="Move down"
            className="text-[10px] text-[color:var(--tx3)] hover:text-[color:var(--tx)] disabled:opacity-30"
            disabled={isLast}
            onClick={() => swapWith(nextId, nextPosition)}
            type="button"
          >
            ▼
          </button>
        </div>
        <Input
          aria-label="Column name"
          className="min-w-0 flex-1"
          onBlur={commitName}
          onChange={(event) => setName(event.target.value)}
          size="compact"
          value={name}
        />
        <CategorySelect ariaLabel="Column category" onChange={commitCategory} value={column.category} />
        <button
          className="text-xs text-[color:var(--tx3)] hover:text-[color:var(--danger-text)]"
          onClick={() => setDeleteOpen(true)}
          type="button"
        >
          Delete
        </button>
      </div>

      <ConfirmDialog
        confirmLabel="Delete"
        destructive
        onCancel={() => setDeleteOpen(false)}
        onConfirm={() => {
          setDeleteOpen(false)
          remove.mutate(column.id)
        }}
        open={deleteOpen}
        title={`Delete column "${column.name}"?`}
      />
    </>
  )
}

type ProjectSettingsPageProps = {
  projectId: string
}

export const ProjectSettingsPage = ({ projectId }: ProjectSettingsPageProps) => {
  const isOwner = useIsOwner()
  const boardQuery = useProjectBoard(projectId)
  const board = boardQuery.data
  const setStyle = useSetBoardStyle(projectId)
  const createColumn = useCreateColumn(projectId)

  const [newName, setNewName] = useState('')
  const [newCategory, setNewCategory] = useState<ColumnCategory>('todo')
  const [saveState, setSaveState] = useState<{ status: 'error' | 'idle' | 'success'; message?: string }>({
    status: 'idle',
  })

  // A silent autosave (rename, category, board style) says so — and clears
  // itself, so the banner reads as an acknowledgement rather than a sticky
  // status line.
  useEffect(() => {
    if (saveState.status !== 'success') return
    const id = window.setTimeout(() => setSaveState({ status: 'idle' }), 2500)
    return () => window.clearTimeout(id)
  }, [saveState.status])

  const announceSaved = () => setSaveState({ status: 'success' })
  const announceError = (message: string) => setSaveState({ status: 'error', message })

  return (
    <PageBody width="narrow">
      <QueryState
        errorLabel="Couldn't load board settings."
        loadingLabel="Loading board settings…"
        query={boardQuery}
      >
        {() => {
          if (!board) return null

          if (!isOwner) {
            return (
              <p className="text-sm text-[color:var(--tx3)]">
                Only project owners can change board settings.
              </p>
            )
          }

          const columns = [...board.columns].sort((a, b) => a.position - b.position)

          const handleAdd = () => {
            const trimmed = newName.trim()
            if (!trimmed) return
            createColumn.mutate(
              { name: trimmed, category: newCategory },
              { onSuccess: () => setNewName('') },
            )
          }

          return (
            <>
              <FormSuccess>{saveState.status === 'success' ? 'Saved.' : undefined}</FormSuccess>
              <FormError>{saveState.status === 'error' ? saveState.message : undefined}</FormError>

              <Section
                description="Kanban is a continuous board. Iterations adds a backlog and time-boxed sprints."
                title="Board style"
              >
                <ChoiceGroup
                  label="Board style"
                  labelHidden
                  onChange={(style) =>
                    setStyle.mutate(style, {
                      onError: (cause) => announceError(errorMessage(cause, 'Could not change board style')),
                      onSuccess: announceSaved,
                    })
                  }
                  options={[
                    { label: 'Kanban', value: 'kanban' },
                    { label: 'Iterations (Scrum)', value: 'scrum' },
                  ]}
                  value={board.style}
                />
              </Section>

              <Section
                description="Each column maps to a lifecycle stage so agents and approvals keep working."
                title="Columns"
              >
                <div className="grid gap-2">
                  {columns.map((column, index) => (
                    <ColumnRow
                      key={column.id}
                      column={column}
                      isFirst={index === 0}
                      isLast={index === columns.length - 1}
                      nextId={columns[index + 1]?.id}
                      nextPosition={columns[index + 1]?.position}
                      onSaveError={announceError}
                      onSaved={announceSaved}
                      prevId={columns[index - 1]?.id}
                      prevPosition={columns[index - 1]?.position}
                      projectId={projectId}
                    />
                  ))}
                </div>

                <div className="flex items-center gap-2 border-t border-[color:var(--sep)] pt-3">
                  <Input
                    aria-label="New column name"
                    className="min-w-0 flex-1"
                    onChange={(event) => setNewName(event.target.value)}
                    placeholder="New column name…"
                    size="compact"
                    value={newName}
                  />
                  <CategorySelect ariaLabel="New column category" onChange={setNewCategory} value={newCategory} />
                  <button
                    className="admin-button admin-button-primary admin-button-compact"
                    disabled={!newName.trim() || createColumn.isPending}
                    onClick={handleAdd}
                    type="button"
                  >
                    Add column
                  </button>
                </div>
              </Section>
            </>
          )
        }}
      </QueryState>
    </PageBody>
  )
}

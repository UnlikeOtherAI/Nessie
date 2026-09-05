import { useState } from 'react'
import type { BoardColumnRecord, ColumnCategory } from '../../../facades/boards/hooks'
import { useCreateColumn, useDeleteColumn, useUpdateColumn } from '../../../facades/boards/hooks'
import { ConfirmDialog } from '../../../components/shared/ConfirmDialog'
import { Input, Select } from '../../../components/shared/FormControls'
import { CATEGORY_LABEL, CATEGORY_ORDER } from '../../../components/kanban/kanban-config'

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
  boardId: string
  column: BoardColumnRecord
  isFirst: boolean
  isLast: boolean
  nextId?: string
  nextPosition?: number
  onSaveError: (message: string) => void
  onSaved: () => void
  prevId?: string
  prevPosition?: number
  projectId: string
}

const ColumnRow = ({
  boardId,
  column,
  isFirst,
  isLast,
  nextId,
  nextPosition,
  onSaveError,
  onSaved,
  prevId,
  prevPosition,
  projectId,
}: ColumnRowProps) => {
  const update = useUpdateColumn(projectId, boardId)
  const remove = useDeleteColumn(projectId, boardId)
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
        onError: (cause) =>
          onSaveError(errorMessage(cause, 'Could not change column category')),
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
            className="text-[10px] text-[color:var(--tx3)] hover:text-[color:var(--tx)]
              disabled:opacity-30"
            disabled={isFirst}
            onClick={() => swapWith(prevId, prevPosition)}
            type="button"
          >
            ▲
          </button>
          <button
            aria-label="Move down"
            className="text-[10px] text-[color:var(--tx3)] hover:text-[color:var(--tx)]
              disabled:opacity-30"
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
        <CategorySelect
          ariaLabel="Column category"
          onChange={commitCategory}
          value={column.category}
        />
        <button
          className="text-xs text-[color:var(--tx3)] hover:text-[color:var(--danger-text)]"
          onClick={() => setDeleteOpen(true)}
          type="button"
        >
          Delete
        </button>
      </div>

      <ConfirmDialog
        body="Cards in it move to the first column of the same stage. No work is deleted."
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

type BoardColumnsEditorProps = {
  boardId: string
  columns: BoardColumnRecord[]
  onSaveError: (message: string) => void
  onSaved: () => void
  projectId: string
}

/**
 * The columns of one board. Every column maps to one of the four lifecycle
 * stages, because those are what the worker, approvals and transitions drive —
 * a board with no column for a stage simply does not show that work, which is
 * how a "Review queue" board is built without any filter vocabulary.
 */
export const BoardColumnsEditor = ({
  boardId,
  columns,
  onSaveError,
  onSaved,
  projectId,
}: BoardColumnsEditorProps) => {
  const createColumn = useCreateColumn(projectId, boardId)
  const [newName, setNewName] = useState('')
  const [newCategory, setNewCategory] = useState<ColumnCategory>('todo')
  const ordered = [...columns].sort((a, b) => a.position - b.position)

  const handleAdd = () => {
    const trimmed = newName.trim()
    if (!trimmed) return
    createColumn.mutate(
      { name: trimmed, category: newCategory },
      {
        onError: (cause) => onSaveError(errorMessage(cause, 'Could not add column')),
        onSuccess: () => setNewName(''),
      },
    )
  }

  return (
    <>
      <div className="grid gap-2">
        {ordered.map((column, index) => (
          <ColumnRow
            key={column.id}
            boardId={boardId}
            column={column}
            isFirst={index === 0}
            isLast={index === ordered.length - 1}
            nextId={ordered[index + 1]?.id}
            nextPosition={ordered[index + 1]?.position}
            onSaveError={onSaveError}
            onSaved={onSaved}
            prevId={ordered[index - 1]?.id}
            prevPosition={ordered[index - 1]?.position}
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
        <CategorySelect
          ariaLabel="New column category"
          onChange={setNewCategory}
          value={newCategory}
        />
        <button
          className="admin-button admin-button-primary admin-button-compact"
          disabled={!newName.trim() || createColumn.isPending}
          onClick={handleAdd}
          type="button"
        >
          Add column
        </button>
      </div>
    </>
  )
}

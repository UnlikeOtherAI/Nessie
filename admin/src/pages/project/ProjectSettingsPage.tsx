import { useState } from 'react'
import {
  type BoardColumn,
  type ColumnCategory,
  useCreateColumn,
  useDeleteColumn,
  useProjectBoard,
  useSetBoardStyle,
  useUpdateColumn,
} from '../../facades/board/hooks'
import { ConfirmDialog } from '../../components/shared/ConfirmDialog'
import { CATEGORY_LABEL, CATEGORY_ORDER } from '../../components/kanban/kanban-config'
import { useIsOwner } from '../../components/shared/OwnerGate'

const label = 'text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]'

const CategorySelect = ({
  value,
  disabled,
  onChange,
}: {
  value: ColumnCategory
  disabled?: boolean
  onChange: (category: ColumnCategory) => void
}) => (
  <select
    className="admin-input admin-input-compact max-w-[160px]"
    disabled={disabled}
    onChange={(event) => onChange(event.target.value as ColumnCategory)}
    value={value}
  >
    {CATEGORY_ORDER.map((category) => (
      <option key={category} value={category}>
        {CATEGORY_LABEL[category]}
      </option>
    ))}
  </select>
)

const ColumnRow = ({
  column,
  projectId,
  isFirst,
  isLast,
  prevId,
  nextId,
  prevPosition,
  nextPosition,
}: {
  column: BoardColumn
  projectId: string
  isFirst: boolean
  isLast: boolean
  prevId?: string
  nextId?: string
  prevPosition?: number
  nextPosition?: number
}) => {
  const update = useUpdateColumn(projectId)
  const remove = useDeleteColumn(projectId)
  const [name, setName] = useState(column.name)
  const [deleteOpen, setDeleteOpen] = useState(false)

  const commitName = () => {
    const trimmed = name.trim()
    if (trimmed && trimmed !== column.name) update.mutate({ id: column.id, name: trimmed })
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
        <input
          className="admin-input admin-input-compact min-w-0 flex-1"
          onBlur={commitName}
          onChange={(event) => setName(event.target.value)}
          value={name}
        />
        <CategorySelect
          onChange={(category) => update.mutate({ id: column.id, category })}
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
  const { data: board } = useProjectBoard(projectId)
  const setStyle = useSetBoardStyle(projectId)
  const createColumn = useCreateColumn(projectId)

  const [newName, setNewName] = useState('')
  const [newCategory, setNewCategory] = useState<ColumnCategory>('todo')

  if (!board) {
    return <div className="p-6 text-sm text-[color:var(--tx3)]">Loading…</div>
  }

  if (!isOwner) {
    return (
      <div className="p-6 text-sm text-[color:var(--tx3)]">
        Only project owners can change board settings.
      </div>
    )
  }

  const columns = [...board.columns].sort((a, b) => a.position - b.position)

  const handleAdd = () => {
    const trimmed = newName.trim()
    if (!trimmed) return
    createColumn.mutate({ name: trimmed, category: newCategory }, { onSuccess: () => setNewName('') })
  }

  return (
    <div className="min-h-0 overflow-y-auto p-6">
      <div className="mx-auto grid max-w-2xl gap-8">
        <section className="grid gap-3">
          <div className={label}>Board style</div>
          <div className="flex gap-2">
            {(['kanban', 'scrum'] as const).map((style) => (
              <button
                key={style}
                className={[
                  'admin-button',
                  board.style === style ? 'admin-button-primary' : 'admin-button-secondary',
                ].join(' ')}
                disabled={setStyle.isPending}
                onClick={() => setStyle.mutate(style)}
                type="button"
              >
                {style === 'kanban' ? 'Kanban' : 'Iterations (Scrum)'}
              </button>
            ))}
          </div>
          <p className="text-xs text-[color:var(--tx3)]">
            Kanban is a continuous board. Iterations adds a backlog and time-boxed sprints.
          </p>
        </section>

        <section className="grid gap-3">
          <div className={label}>Columns</div>
          <div className="grid gap-2">
            {columns.map((column, index) => (
              <ColumnRow
                key={column.id}
                column={column}
                isFirst={index === 0}
                isLast={index === columns.length - 1}
                nextId={columns[index + 1]?.id}
                nextPosition={columns[index + 1]?.position}
                prevId={columns[index - 1]?.id}
                prevPosition={columns[index - 1]?.position}
                projectId={projectId}
              />
            ))}
          </div>

          <div className="mt-2 flex items-center gap-2 border-t border-[color:var(--sep)] pt-3">
            <input
              className="admin-input admin-input-compact min-w-0 flex-1"
              onChange={(event) => setNewName(event.target.value)}
              placeholder="New column name…"
              value={newName}
            />
            <CategorySelect onChange={setNewCategory} value={newCategory} />
            <button
              className="admin-button admin-button-primary admin-button-compact"
              disabled={!newName.trim() || createColumn.isPending}
              onClick={handleAdd}
              type="button"
            >
              Add column
            </button>
          </div>
          <p className="text-xs text-[color:var(--tx3)]">
            Each column maps to a lifecycle stage so agents and approvals keep working.
          </p>
        </section>
      </div>
    </div>
  )
}
